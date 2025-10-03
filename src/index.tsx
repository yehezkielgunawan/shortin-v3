import { Hono } from "hono";
import { renderer } from "@/renderer";
import api from "@/routes/api";
import web from "@/routes/web";
import redirect from "@/routes/redirect";

const app = new Hono();

app.use(renderer);

// API namespace
app.route("/api", api);

// Frontend routes
app.route("/", web);

// Redirect short code
app.route("/", redirect);

export default app;
