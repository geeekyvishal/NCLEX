import type { FastifyInstance, FastifyRequest } from "fastify";
import { jobs } from "../../infra/index.js";

export async function registerProgressSocket(app: FastifyInstance) {
  app.get(
    "/api/jobs/:jobId/progress",
    { websocket: true },
    (connection, request: FastifyRequest<{ Params: { jobId: string } }>) => {
      const { jobId } = request.params;

      const unsubscribe = jobs.subscribeProgress(jobId, (event) => {
        if (connection.socket.readyState === connection.socket.OPEN) {
          connection.socket.send(JSON.stringify(event));
        }

        // Close subscription and socket when a terminal stage arrives.
        if (event.stage === "done" || event.stage === "failed") {
          unsubscribe();
          connection.socket.close();
        }
      });

      connection.socket.on("close", () => {
        unsubscribe();
      });

      connection.socket.on("error", () => {
        unsubscribe();
      });
    }
  );
}
