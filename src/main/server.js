const http = require('http');

const BODY_LIMIT = 262144;

function startServer(port, onEvent) {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/event') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > BODY_LIMIT) req.destroy();
      });
      req.on('end', () => {
        try {
          const evt = JSON.parse(body);
          if (!evt.type) evt.type = url.searchParams.get('type') || '';
          // 어느 에이전트의 hook인지. 옛 hook 등록(인자 없음)은 claude로 본다
          if (!evt.agent) evt.agent = url.searchParams.get('agent') || 'claude';
          if (req.headers['x-term-program']) evt.term_program = req.headers['x-term-program'];
          if (req.headers['x-bundle-id']) evt.bundle_id = req.headers['x-bundle-id'];
          onEvent(evt);
        } catch (e) {
          console.error('[server] bad payload: ' + e.message);
        }
        res.writeHead(204);
        res.end();
      });
    } else if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  srv.listen(port, '127.0.0.1', () => {
    console.log('[server] listening on 127.0.0.1:' + port);
  });
  srv.on('error', (e) => console.error('[server] ' + e.message));
  return srv;
}

module.exports = startServer;
