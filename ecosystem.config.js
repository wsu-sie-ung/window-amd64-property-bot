module.exports = {
  apps: [
    {
      name: "property-bot",
      script: "express.js",
      cwd: "C:/Users/Administrator/window-amd64-property-bot",

      // Puppeteer + shared Chromium profiles under profiles/ must NOT be
      // clustered — parallel instances corrupt the profile lock files.
      instances: 1,
      exec_mode: "fork",

      autorestart: true,
      // Puppeteer leaks memory over long runs; recycle before it eats the box.
      max_memory_restart: "1500M",

      // Do NOT watch — the profiles/ dir has 8500+ files and would thrash restarts.
      watch: false,

      // Keep a crash-loop from hammering the machine.
      min_uptime: "30s",
      max_restarts: 10,
      restart_delay: 5000,

      env: {
        NODE_ENV: "production",
        PORT: 3000
      },

      // Timestamped, split logs under ./logs
      time: true,
      out_file: "./logs/property-bot-out.log",
      error_file: "./logs/property-bot-error.log",
      merge_logs: true
    },

    {
      // Pre-earns Cloudflare's cf_clearance cookie for each profiles/<agent> folder
      // so the bot (property-bot) rides past the challenge. Runs real Edge, not
      // Puppeteer. See warmup.js.
      name: "property-bot-warmup",
      script: "warmup.js",
      cwd: "C:/Users/Administrator/window-amd64-property-bot",

      // A one-shot batch job, NOT a daemon: it opens Edge per profile, then exits.
      // autorestart:false stops PM2 relaunching it in a tight loop; cron_restart is
      // the ONLY thing that re-runs it. (PM2 also runs it once on initial start.)
      autorestart: false,
      cron_restart: "0 */4 * * *",   // every 4h — tune to your cf_clearance lifetime

      // Never cluster: parallel Edge on the same profile corrupts its lock files.
      instances: 1,
      exec_mode: "fork",
      interpreter: "node",
      watch: false,

      env: {
        NODE_ENV: "production"
      },

      time: true,
      out_file: "./logs/property-bot-warmup-out.log",
      error_file: "./logs/property-bot-warmup-error.log",
      merge_logs: true
    }
  ]
};
