module.exports = {
  apps: [{
    name: "coding-orchestrator",
    cwd: "/home/lukman-ss/coding-orchestrator",
    script: "src/server.js",
    node_args: "--env-file=/home/lukman-ss/coding-orchestrator/.env",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false
  }]
};
