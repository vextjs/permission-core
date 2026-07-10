import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get("/api/users", {
    auth: {
      permissions: [{ action: "invoke", resource: "api:GET:/api/users" }],
    },
  }, async (_req, res) => {
    res.json({ users: [{ id: "user-1" }] });
  });

  app.delete("/api/users/:id", {
    auth: {
      permissions: [{ action: "invoke", resource: "api:DELETE:/api/users/:id" }],
    },
  }, async (_req, res) => {
    res.json({ deleted: true });
  });
});
