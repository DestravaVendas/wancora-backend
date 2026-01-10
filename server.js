import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import router from "./routes.js";

// --- IMPORTANTE: Inicia o Worker de Campanhas em paralelo ---
import './workers/campaignWorker.js'; 
// -----------------------------------------------------------

dotenv.config();

// Cria o app (Removemos o import duplicado do app.js)
const app = express();

// Middlewares de Segurança e Performance
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

// Rotas da API
app.use("/api/v1", router);

// Health Check para o Render
app.get("/health", (req, res) => res.status(200).send("Wancora Core Online"));

// Mantivemos 3001 para compatibilidade com seu ambiente local
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`🚀 Wancora CRM Backend rodando na porta ${PORT}`);
  console.log(`🛡️ Persistência: Supabase PostgreSQL (Sem arquivos locais)`);
  console.log(`🤖 Worker de Campanhas: ATIVO`);
});