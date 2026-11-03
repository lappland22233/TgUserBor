import type * as http from 'http';

export class SSEHub {
  private clients = new Set<http.ServerResponse>();

  addClient(res: http.ServerResponse): () => void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    res.write('event: connected\ndata: {"status":"connected"}\n\n');
    this.clients.add(res);

    const cleanup = () => {
      this.clients.delete(res);
      try {
        res.end();
      } catch {
        /* ignore */
      }
    };

    res.on('close', cleanup);
    res.on('finish', cleanup);
    return cleanup;
  }

  broadcast(event: string, data: any): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  startHeartbeat(intervalMs: number = 15000): () => void {
    const timer = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.write(': heartbeat\n\n');
        } catch {
          this.clients.delete(client);
        }
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }
}

