/** @type {import('pm2').StartOptions} */
module.exports = {
  apps: [
    {
      name: process.env.APP_NAME || "webhook",
      script: "index.js",
      interpreter: "node",
      autorestart: true,
      watch: false,
      max_memory_restart: "100M",
      env: {
        NODE_ENV: "production",
        APP_NAME: process.env.APP_NAME,
        COMMAND: process.env.COMMAND,
        SECRET: process.env.SECRET,
        PORT: process.env.PORT || "3002",
      },
    },
  ],
};
