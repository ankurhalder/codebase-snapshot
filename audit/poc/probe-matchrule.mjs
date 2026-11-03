import { matchRule } from "../../dist/index.js";

const cases = [
  ["src/app/route.ts", "src/app/**"],
  ["src/apple/pie.ts", "src/app/**"],
  ["src/application/server.ts", "src/app/**"],
  ["src/app2/x.ts", "src/app/**"],
  ["src/features/x/y.ts", "**/features/**"],
  ["src/app/main.ts", "**/*.ts"],
  ["a.test.ts", /\.test\.ts$/],
];
for (const [file, rule] of cases) {
  console.log(JSON.stringify(file).padEnd(30), String(rule).padEnd(20), "=>", matchRule(file, rule));
}
const stateful = /x/g;
console.log("stateful #1:", matchRule("x", stateful), " #2:", matchRule("x", stateful));
