"use strict";

/**
 * Installs/removes the Excalihere static server as a Windows service.
 *
 * Usage (from an *elevated* prompt):
 *   node service.js install
 *   node service.js uninstall
 *   node service.js start | stop | status
 */

const path = require("path");
const { execFileSync } = require("child_process");
const { Service } = require("node-windows");

const SERVICE_NAME = "Excalihere";
const SCRIPT = path.resolve(__dirname, "server.js");

const svc = new Service({
  name: SERVICE_NAME,
  description: "Serves the Excalihere drawing app on localhost.",
  script: SCRIPT,
  // Restart rather than give up if the process dies, but back off so a
  // genuinely broken build does not spin.
  wait: 2,
  grow: 0.5,
  maxRestarts: 10,
  env: [
    { name: "EXCALIHERE_PORT", value: process.env.EXCALIHERE_PORT || "5178" },
    { name: "EXCALIHERE_HOST", value: process.env.EXCALIHERE_HOST || "127.0.0.1" },
  ],
});

const sc = (...args) => {
  try {
    return execFileSync("sc.exe", args, { encoding: "utf8" });
  } catch (error) {
    return (error.stdout || "") + (error.stderr || "");
  }
};

/** node-windows appends ".exe" internally; the registered name uses no spaces. */
const serviceId = () => SERVICE_NAME.replace(/[^\w]/g, "");

const isElevated = () => {
  try {
    // Only an administrator can read the SYSTEM hive this way.
    execFileSync("net", ["session"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const requireElevation = (action) => {
  if (!isElevated()) {
    console.error(
      `"${action}" needs Administrator rights.\n` +
        `Open PowerShell as Administrator, then run it again from ${__dirname}.`,
    );
    process.exit(1);
  }
};

const command = (process.argv[2] || "").toLowerCase();

switch (command) {
  case "install": {
    requireElevation("install");
    svc.on("install", () => {
      console.log(`Installed "${SERVICE_NAME}". Starting…`);
      svc.start();
    });
    svc.on("alreadyinstalled", () => {
      console.log(
        `"${SERVICE_NAME}" is already installed. Use "uninstall" first to reinstall.`,
      );
    });
    svc.on("start", () => {
      const port = process.env.EXCALIHERE_PORT || "5178";
      console.log(`Running: http://localhost:${port}`);
      console.log("It will now start automatically on boot.");
    });
    svc.on("error", (error) => {
      console.error("Service error:", error);
      process.exitCode = 1;
    });
    svc.install();
    break;
  }

  case "uninstall": {
    requireElevation("uninstall");
    svc.on("uninstall", () => {
      console.log(`Removed "${SERVICE_NAME}".`);
    });
    svc.on("alreadyuninstalled", () => {
      console.log(`"${SERVICE_NAME}" is not installed.`);
    });
    svc.on("error", (error) => {
      console.error("Service error:", error);
      process.exitCode = 1;
    });
    svc.uninstall();
    break;
  }

  case "start":
    requireElevation("start");
    console.log(sc("start", serviceId()).trim());
    break;

  case "stop":
    requireElevation("stop");
    console.log(sc("stop", serviceId()).trim());
    break;

  case "status": {
    const out = sc("query", serviceId());
    if (/FAILED 1060/.test(out)) {
      console.log(`"${SERVICE_NAME}" is not installed.`);
    } else {
      console.log(out.trim());
    }
    break;
  }

  default:
    console.log(
      [
        "Excalihere service control",
        "",
        "  node service.js install     install and start (Administrator)",
        "  node service.js uninstall   stop and remove   (Administrator)",
        "  node service.js start       start it          (Administrator)",
        "  node service.js stop        stop it           (Administrator)",
        "  node service.js status      show current state",
        "",
        `Script served: ${SCRIPT}`,
      ].join("\n"),
    );
}
