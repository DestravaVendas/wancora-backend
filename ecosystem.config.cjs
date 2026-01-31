module.exports = {
  apps: [{
    name: "wancora-backend",
    script: "./server.js",
    
    // IMPORTANTE: Baileys precisa de estado em memória. 
    // Não altere para 'max' ou cluster mode sem refatorar para Redis Pub/Sub.
    instances: 1, 
    exec_mode: "fork",
    
    // Reinicia se consumir muita memória (Baileys é pesado)
    max_memory_restart: '2048M', 
    
    // Configurações de Ambiente
    env: {
      NODE_ENV: "development",
    },
    env_production: {
      NODE_ENV: "production",
    },

    // Logs (opcional, ajuda a debugar em produção)
    error_file: "./logs/pm2-error.log",
    out_file: "./logs/pm2-out.log",
    merge_logs: true,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    
    // Resiliência
    autorestart: true,
    watch: false, // Não assistir arquivos em produção
    exp_backoff_restart_delay: 100 // Delay se crashar repetidamente
  }]
}