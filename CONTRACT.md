# Internal integration contract

Node ESM. Backend engine: server/manager.mjs exports SessionManager extends EventEmitter.
Constructor {dataDir, maxConcurrent = 4}; methods list(), get(id), logs(id) -> {data,run}, create(spec), update(id,spec), start(id), stop(id), restart(id), remove(id), write(id,data), resize(id,cols,rows), setLimit(n), stopAll(), shutdown(). Async actions may return promises; API always awaits them. maxConcurrent property. Events session(session), output({id,run,data}), deleted({id}), settings({maxConcurrent}).
Session: {id,name,command,args:string[],cwd,group,status,createdAt,startedAt,endedAt,pid,exitCode,error,run,cols,rows}. States idle,queued,starting,running,stopping,completed,failed,stopped,interrupted. create(spec) does not auto-start; server handles autoStart. Only stopped sessions can edit/delete; restart must stop then queue exactly once. JSON persistence and bounded terminal logs. No automatic relaunch on server restart.

Environment module server/environment.mjs exports async getPresets() -> array {id,name,command,args,cwd,available,description}; async discoverProcesses() -> {processes:[{pid,name,command,startedAt}],error?}; process discovery read-only; command must avoid secrets (executable label only); no arbitrary process killing.

HTTP API uses same-origin HttpOnly local session cookie set by GET /. All mutations JSON:
GET /api/bootstrap -> {sessions,settings:{maxConcurrent},presets,platform,homeDirectory,version}
POST /api/sessions body {name,command,args,cwd,group,autoStart} -> session
PATCH /api/sessions/:id body editable spec -> session
POST /api/sessions/:id/start|stop|restart -> session
DELETE /api/sessions/:id -> {ok:true}
GET /api/sessions/:id/log -> {data,run}
GET /api/sessions/:id/export -> text log download
PATCH /api/settings {maxConcurrent} -> {maxConcurrent}
POST /api/stop-all -> {ok:true}
GET /api/processes -> {processes,error?}
Errors status 400/404/409/500 with {error:message}.

WebSocket /ws: server first {type:'snapshot',sessions,settings}; updates {type:'session',session}, {type:'output',id,run,data}, {type:'deleted',id}, {type:'settings',maxConcurrent}; client {type:'subscribe',id} -> {type:'replay',id,data,run} and subsequent output (one or many subscribed ids); {type:'unsubscribe',id}; {type:'input',id,data}; {type:'resize',id,cols,rows}; errors {type:'error',error}. On reconnect UI re-subscribes, resets terminal on replay and run changes. Subscribe snapshots and live output are sequenced synchronously server-side.

Frontend owns web/index.html,web/app.js,web/style.css. Bundle using esbuild to dist/app.js and dist/app.css; index uses those files. xterm imports @xterm/xterm, @xterm/addon-fit and @xterm/xterm/css/xterm.css. UI Korean. App name Kernel Deck. Fonts Segoe UI/Malgun Gothic; terminal Cascadia Code/Consolas. Light cool workspace with slate-blue sidebar (#24344b), off-white canvas (#f3f6fa), cobalt action (#355fe5), teal state (#177d76), orange attention (#bd651a); dark terminals only. Left session navigation plus flexible 2x2 terminal tiles and focus mode. Avoid decorative metrics/hero. Useful empty state add-session action, installed CLI presets, manual command + argument lines, group/name, cwd. Search/filter; limit selector; per-session controls; reconnect status; logs download; external processes observation; browser refresh keeps managed processes running.

Release includes a Windows x64 portable ZIP, bundled Node runtime, launch/stop scripts and component licenses. GitHub Actions validates Windows tests and the browser flow. Runtime data, credentials and test artifacts are excluded from Git and release archives.
