
// Import with `import "./instrument.js"` at the top of server.js
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

// Inicializa Sentry apenas se a DSN estiver definida no .env
if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        integrations: [
            nodeProfilingIntegration(),
        ],
        // Performance Monitoring
        tracesSampleRate: 1.0, //  Capture 100% of the transactions (adjust for production)
        // Set sampling rate for profiling - this is relative to tracesSampleRate
        profilesSampleRate: 1.0,
    });
    console.log("🛡️ [SENTRY] Monitoramento ativado.");
} else {
    console.log("ℹ️ [SENTRY] DSN não encontrada. Monitoramento desativado.");
}
