# Gone

A quiet, green task list for your iPhone. Type directly into the unboxed **Add a task…** line. An empty line appears underneath while you type; tap it to save the current task and start another without pressing Enter. Enter still saves a task, and unfinished typing is kept locally if you reopen the app. Tap a task’s circle or line to cross it off. Unfinished tasks leave the list after 24 hours. **Weekly report** shows completed tasks versus tasks you let go.

This is an independent web recreation of the described experience. It does not connect to the original Gone website or account, and it is not an App Store binary.

## Put it on your iPhone

The app needs a stable **HTTPS website** for installation and offline use. The production files in `dist/` are a plain static site; no server runtime, database, API keys, or paid backend are required.

1. Download and unzip the supplied website package. If working from source, run `npm ci` and `npm run build` to create `dist/`.
2. Sign in to [Netlify Drop](https://app.netlify.com/drop) and drag in the unzipped `dist` folder. The folder you upload must contain `index.html` directly. Another HTTPS static host works too.
3. Open the resulting **HTTPS URL in Safari on your iPhone**.
4. Tap Safari’s **Share** button, then **Add to Home Screen**. If offered, leave **Open as Web App** enabled. Tap **Add**.
5. Open **Gone** from its new Home Screen icon. Open the help panel and wait for **Ready for offline use** before relying on it without a connection.

Install before adding important tasks, and keep using the same installed app and website address. Safari and Home Screen apps may use separate storage. Changing the host or website address can also create a separate task store.

## What happens after 24 hours

- Each task gets exactly 24 hours from the moment you create it, rather than until midnight.
- The time on the right rounds the remaining time up to whole hours. It is faint grey above 18 hours, normal above 3 hours through 18 hours, muted amber above 1 hour through 3 hours, and red at 1 hour or less.
- Tap a task’s circle or line to cross it off; tap again before its deadline to mark it unfinished. Completed tasks stay in place with a crossed-out line.
- Swipe left to reveal a red bin button, then tap it to delete. Swipe right to reveal a blue pencil button, then tap it to edit. Hold a task for a moment, then drag it up or down to reorder; its position is saved on the device. Editing preserves the original 24-hour deadline. A keyboard-accessible task menu provides the same actions.
- Crossing off a task plays a quiet, original bell chime. The sound is generated on the device and works offline. Turn it off with **Help → Completion sound**. Device volume and iOS audio settings still apply. Undoing a completion or letting a task expire stays silent.
- At the original deadline, a completed task leaves the visible list and remains counted as completed. An unfinished task is recorded as removed at that deadline.
- Deleting an unfinished task counts it as removed on the deletion day. Deleting a completed task keeps its completion total and does not count it twice.
- iPhone does not let a closed web app run continuously in the background. Expiration is checked while Gone is open and immediately when you return. Overdue tasks disappear on return, and their reports use the original deadline.
- Reports follow your device’s local time, with weeks starting on Monday. Use the report arrows to revisit earlier weeks. Completion is counted on the day you finish a task; removal is counted on its deadline day.

## Your data

Tasks and report history stay in this app’s local browser storage on your device. There is no account, analytics, cloud sync, or connection to the original app. Task records are retained locally to calculate previous reports.

There is currently no export or backup feature. Clearing website data, removing the web app, private browsing, device storage cleanup, or changing phones can lose your tasks and history. Do not use it as the only record of important information. A visible warning appears if the browser cannot read or save the task store.

## Development

Use Node.js 22 or newer and run commands from this repository:

```sh
npm ci
npm run dev
```

The development server uses port 3000 by default; set `PORT` to change it. HTTPS is required for an iPhone installation. The development server itself provides HTTP and is intended for local development.

```sh
npm test
npm run test:browser
npm run build
```

The unit suite checks task deadlines and weekly reports. The browser suite exercises the app and offline behavior using Playwright. If Chromium is not available, install Playwright’s browser with `npx playwright install chromium`. For a system installation, run `CHROMIUM_PATH=/usr/bin/chromium npm run test:browser` with the appropriate executable path.

The build copies only the production app into `dist/`. It does not bundle development dependencies. To serve that build locally, run `SERVE_DIST=1 npm start`.

When changing an offline-cached app file, bump the cache version in `sw.js` and the matching asset query versions in `index.html`, `app.js`, and the worker’s precache list before building and deploying. Release-tagged imports keep an older installed worker from mixing incompatible JavaScript files. Keep the same production URL to preserve the device’s existing task store.
