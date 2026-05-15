import fs from "node:fs";
import path from "node:path";

export function createUserStateStore(config) {
  const statePath = path.join(config.dataPath, "user-state.json");

  function load() {
    try {
      if (!fs.existsSync(statePath)) return {};
      const data = JSON.parse(fs.readFileSync(statePath, "utf8"));
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  function save(nextState) {
    if (!nextState || typeof nextState !== "object") {
      throw new Error("User state must be a JSON object");
    }
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const body = {
      ...nextState,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(statePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    return body;
  }

  function getPath() {
    return statePath;
  }

  return { load, save, getPath };
}
