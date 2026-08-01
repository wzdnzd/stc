import { handleRequest } from "./router.js";
import { errorResponse, htmlResponse, renderErrorPage } from "./responses.js";

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("Unhandled error", error?.stack || error);
      if (new URL(request.url).pathname.startsWith("/api/")) {
        return errorResponse(error);
      }
      return htmlResponse(renderErrorPage(error), error?.status || 500);
    }
  },
};
