import { installPackage } from "../../src/packages/store.js";

const [configPath, dataHome, source, alias] = process.argv.slice(2);
if (!configPath || !dataHome || !source || !alias) throw new Error("package install fixture arguments missing");
await installPackage({ configPath, dataHome, source, alias });
