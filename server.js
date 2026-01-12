import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import router from "./routes.js";
import { supabase } from "./auth/supabaseAuth.js"; // Importe o cliente supabase
import { startSession } from "./controllers/whatsappController.js"; // Importe a função de iniciar

// --- IMPORTANTE: Inicia o Worker de Campanhas em paralelo ---
import './workers/campaignWorker.js'; 
// -----------------------------------------------------------

dotenv.config();

const app = express();

// Middlewares de Segurança e Performance
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: '50mb' })); // Aumentado para suportar upload de mídia
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Rotas da API
app.use("/api/v1", router);

// Health Check para o Render
app.get("/health", (req, res) => res.status(200).send("Wancora Core Online"));

const PORT = process.env.PORT || 3001;

// --- PROTOCOLO DE RESSURREIÇÃO ---
async function restoreSessions() {
  console.log('🔄 [SYSTEM] Iniciando restauração de sessões...');
  try {
    const { data: instances, error } = await supabase
      .from('instances')
      .select('session_id, company_id') // Precisamos do company_id também
      .eq('status', 'connected');

    if (error) {
      console.error('❌ Erro ao buscar instâncias:', error);
      return;
    }

    if (instances && instances.length > 0) {
      console.log(`🔌 [SYSTEM] Encontradas ${instances.length} sessões para reconectar.`);
      for (const instance of instances) {
        console.log(`♻️ [SYSTEM] Reconectando: ${instance.session_id}`);
        // Chama a função startSession que já existe no seu controller
        await startSession(instance.session_id, instance.company_id); 
      }
    } else {
      console.log('ℹ️ [SYSTEM] Nenhuma sessão ativa para restaurar.');
    }
  } catch (err) {
    console.error('❌ Falha crítica na restauração:', err);
  }
}

app.listen(PORT, async () => {
  console.log(`🚀 Wancora CRM Backend rodando na porta ${PORT}`);
  console.log(`🛡️ Persistência: Supabase PostgreSQL`);
  console.log(`🤖 Worker de Campanhas: ATIVO`);
  
  // Executa a restauração ao iniciar
  await restoreSessions();
});