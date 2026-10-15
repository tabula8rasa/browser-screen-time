# Browser Screen Time (Personal) — Privacy

This extension stores daily per-domain screen time, session timestamps, its domain
registry, and settings locally in Firefox. It has no backend, account system,
analytics service, or cloud synchronization. Screen-time totals and session
history are not uploaded by the extension.

When the dashboard displays website icons, Firefox requests each website's
`https://<domain>/favicon.ico` directly. There is no third-party favicon service.
These requests reveal the requested domain and normal connection information
(such as the IP address) to that website; Firefox controls its ordinary cache and
cookie behavior. The extension omits the referrer and does not itself read cookies.

The personal release declares `browsingActivity` in Firefox's data-consent manifest
because icon requests use domains from the local statistics. This declaration
covers the existing icon behavior; it does not add any telemetry or server upload.

Exported backups are local files created at the user's request. Import and reset
operate on local data. Reset time data clears the tracked statistics and sessions
while preserving settings. Uninstalling is managed by Firefox.
