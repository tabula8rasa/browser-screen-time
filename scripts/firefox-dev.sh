#!/usr/bin/env bash
# Linux development supervisor. Never uses the normal Firefox profile.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
STATE="$ROOT/.dev"
PROFILE="$STATE/firefox-profile"
SELF="$ROOT/scripts/firefox-dev.sh"
[[ ! -L "$STATE" && ! -L "$PROFILE" ]] || {
    echo 'Refusing a symlinked development state/profile directory.' >&2; exit 1;
}
mkdir -p "$STATE"
chmod 700 "$STATE"
cd "$ROOT"

birth() {
    local stat
    local -a fields
    [[ -r /proc/$1/stat ]] || return 1
    stat=$(cat "/proc/$1/stat") || return 1
    stat=${stat##*) }
    # The remaining fields begin at field 3; starttime is field 22.
    read -ra fields <<< "$stat"
    [[ ${fields[0]} != Z ]] || return 1
    printf '%s\n' "${fields[19]}"
}

record() {
    printf '%s %s %s\n' "$2" "$(birth "$2")" "$FIREFOX_DEV_RUN_TOKEN" > "$STATE/$1.pid"
}

alive() {
    local pid started token actual
    [[ -f "$STATE/$1.pid" ]] || return 1
    read -r pid started token < "$STATE/$1.pid"
    [[ $pid =~ ^[0-9]+$ && -n $started && -n $token ]] || return 1
    actual=$(birth "$pid") || return 1
    [[ $actual == "$started" ]] &&
        grep -zFxq "FIREFOX_DEV_RUN_TOKEN=$token" "/proc/$pid/environ" 2>/dev/null
}

# Check a surviving group member's run token even if its leader exited.
# Never signal a group merely because its number was recorded in a PID file.
owned_group() {
    local name=$1 group started token pid pgid
    [[ -f "$STATE/$name.pid" ]] || return 1
    read -r group started token < "$STATE/$name.pid"
    [[ $group =~ ^[0-9]+$ && $group -gt 1 && -n $token ]] || return 1
    while read -r pid pgid; do
        if [[ $pgid == "$group" ]] && birth "$pid" >/dev/null 2>&1 &&
            grep -zFxq "FIREFOX_DEV_RUN_TOKEN=$token" "/proc/$pid/environ" 2>/dev/null; then
            return 0
        fi
    done < <(ps -eo pid=,pgid=)
    return 1
}

signal_group() {
    local name=$1 signal=$2 group rest
    if owned_group "$name"; then
        read -r group rest < "$STATE/$name.pid"
        kill -s "$signal" -- "-$group" 2>/dev/null || true
    fi
}

clean_children() {
    # TERM lets Firefox shut down and retain test-site state.
    signal_group webpack TERM
    signal_group web-ext TERM
    for ((i=0; i<40; i++)); do
        if ! owned_group webpack && ! owned_group web-ext; then break; fi
        sleep 0.25
    done
    for name in webpack web-ext; do
        if owned_group "$name"; then
            echo "Force-stopping unresponsive owned $name process group."
            signal_group "$name" KILL
        fi
    done
    wait 2>/dev/null || true
    rm -f "$STATE/webpack.pid" "$STATE/web-ext.pid" "$STATE/supervisor.pid" "$STATE/ready"
}

supervise() {
    exec 8>"$STATE/runtime.lock"
    flock -n 8 || exit 1
    trap 'exit 0' TERM INT HUP
    trap clean_children EXIT
    # Recover only groups carrying a previous runner token, never arbitrary PIDs.
    clean_children
    record supervisor "$$"
    : > "$STATE/webpack.log"
    : > "$STATE/web-ext.log"
    echo "INSECURE DEVELOPMENT PROFILE: $PROFILE"
    echo "Do not sign in to personal accounts or use this Firefox for normal browsing."
    mkdir -p "$PROFILE" "$STATE/tmp" "$STATE/artifacts"
    printf '%s\n' 'Insecure web-ext development profile. Never use for normal browsing.' > "$STATE/PROFILE_WARNING.txt"
    export TMPDIR="$STATE/tmp"
    # Home config is disabled below; discard web-ext environment configuration
    # too, including browser arguments that could override the dedicated profile.
    while IFS= read -r variable; do unset "$variable"; done < <(compgen -v WEB_EXT_)

    setsid npm run watch > "$STATE/webpack.log" 2>&1 8>&- &
    local webpack_pid=$!
    record webpack "$webpack_pid"
    local built=false
    for ((i=0; i<240; i++)); do
        alive webpack || { echo 'Webpack exited; see .dev/webpack.log'; exit 1; }
        if grep -Eq 'compiled (successfully|with [0-9]+ warnings?) in [0-9]+ ms' "$STATE/webpack.log" && [[ -f dist/manifest.json ]]; then
            built=true
            break
        fi
        sleep 0.25
    done
    [[ $built == true ]] || { echo 'Initial build did not succeed within 60 seconds.'; exit 1; }

    # Explicit options defeat global web-ext config/environment defaults.
    # web-ext itself passes -no-remote, guaranteeing a separate Firefox instance.
    setsid "$ROOT/node_modules/.bin/web-ext" run \
        --target firefox-desktop --source-dir "$ROOT/dist" \
        --firefox "${FIREFOX_DEV_BINARY:-$(command -v firefox)}" \
        --firefox-profile "$PROFILE" --profile-create-if-missing \
        --keep-profile-changes --reload --pre-install=false \
        --artifacts-dir "$STATE/artifacts" --no-config-discovery --no-input \
        --start-url about:blank --verbose \
        > "$STATE/web-ext.log" 2>&1 8>&- &
    local runner_pid=$!
    record web-ext "$runner_pid"
    local installed=false
    for ((i=0; i<240; i++)); do
        alive web-ext || { echo 'web-ext exited; see .dev/web-ext.log'; exit 1; }
        if grep -q 'The extension will reload if any source file changes' "$STATE/web-ext.log"; then
            installed=true
            break
        fi
        sleep 0.25
    done
    [[ $installed == true ]] || { echo 'Extension installation timed out.'; exit 1; }
    touch "$STATE/ready"
    echo 'Firefox development environment ready.'
    while alive webpack && alive web-ext; do sleep 1; done
    echo 'A development process exited; shutting down the remaining environment.'
}

status() {
    if alive supervisor && alive webpack && alive web-ext && [[ -f "$STATE/ready" ]]; then
        echo "Running — insecure development profile: $PROFILE"
        for name in supervisor webpack web-ext; do
            read -r pid rest < "$STATE/$name.pid"
            echo "$name PID: $pid"
        done
    elif alive supervisor; then
        echo 'Starting or stopping; see .dev/supervisor.log'
        return 1
    elif owned_group webpack || owned_group web-ext; then
        echo 'Stopped supervisor with surviving owned children; use stop before start.'
        return 1
    else
        echo 'Stopped'
        return 1
    fi
}

start() {
    if alive supervisor; then
        echo 'Development supervisor already running; no duplicate started.'
        status || true
        return
    fi
    for tool in node npm firefox setsid flock ps grep; do
        command -v "$tool" >/dev/null || { echo "Missing command: $tool" >&2; return 1; }
    done
    [[ -x node_modules/.bin/web-ext && -x node_modules/.bin/webpack ]] || {
        echo 'Install project dependencies with npm ci first.' >&2; return 1;
    }
    rm -f "$STATE/ready"
    # Exported at process launch so /proc identity checks also work for the supervisor.
    FIREFOX_DEV_RUN_TOKEN="$(node -e 'console.log(require("crypto").randomUUID())')" \
        nohup setsid bash "$SELF" _supervise > "$STATE/supervisor.log" 2>&1 < /dev/null 9>&- &
    local launched=$!
    for ((i=0; i<520; i++)); do
        if [[ -f "$STATE/ready" ]] && alive supervisor; then status; return; fi
        if ! kill -0 "$launched" 2>/dev/null; then
            echo 'Startup failed. Logs:' >&2
            tail -n 15 "$STATE/supervisor.log" "$STATE/webpack.log" "$STATE/web-ext.log" >&2
            return 1
        fi
        sleep 0.25
    done
    echo 'Startup timed out; stopping the owned environment.' >&2
    stop
    return 1
}

stop() {
    if alive supervisor; then
        read -r pid rest < "$STATE/supervisor.pid"
        kill -TERM "$pid"
        for ((i=0; i<60; i++)); do
            alive supervisor || break
            sleep 0.25
        done
        if alive supervisor; then
            echo 'Supervisor did not exit; inspect .dev/supervisor.log.' >&2
            return 1
        fi
    fi
    clean_children
    echo 'Stopped; development profile retained.'
}

if [[ ${1:-} == _supervise ]]; then
    [[ -n ${FIREFOX_DEV_RUN_TOKEN:-} ]] || exit 1
    supervise
    exit
fi

# Serialize start/stop/restart across terminals; children must not inherit this lock.
exec 9>"$STATE/control.lock"
flock 9
case "${1:-start}" in
    start) start ;;
    stop) stop ;;
    restart) stop; start ;;
    status) status ;;
    logs) flock -u 9; tail -n 80 -F "$STATE/supervisor.log" "$STATE/webpack.log" "$STATE/web-ext.log" ;;
    *) echo "Usage: $0 {start|stop|restart|status|logs}" >&2; exit 2 ;;
esac
