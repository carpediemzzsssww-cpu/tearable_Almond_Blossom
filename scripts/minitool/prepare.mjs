import fs from 'node:fs';
let html = fs.readFileSync('index.html', 'utf8');
html = html.replace(/<script type="module"[^>]+><\/script>/, '<script src="./assets/app.js"></script>');
html = html.replace('</head>', '<link rel="stylesheet" href="./assets/app.css" /></head>');
html = html.replace('</body>', '<button id="restart" type="button" aria-label="再来一次" title="再来一次"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 8a8 8 0 1 1-1 7M5 3v5h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div id="context-status" role="status">画面恢复中…</div></body>');
fs.writeFileSync('dist-minitool/index.html', html);
