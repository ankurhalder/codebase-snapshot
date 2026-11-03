import { scanAndRedactSecrets } from "../../dist/index.js";
const rules = [{ rule: "custom-token", pattern: /^X=SECRET_[A-Z]+$/g }];
const lines = Array.from({ length: 8 }, () => "X=SECRET_ABCDEFGH");
// candidate fix: use String#search, which does not read or mutate lastIndex
const hits = lines.map((l) => rules.filter(({ pattern }) => l.search(pattern) !== -1).length);
console.log("fixed hit counts per line:", hits.join(","));
console.log("rule.lastIndex after 8 lines:", rules[0].pattern.lastIndex);
console.log("all 8 lines hit:", hits.every((h) => h === 1));
console.log("control (pattern.test) hit counts:", lines.map((l) => (rules[0].pattern.test(l) ? 1 : 0)).join(","));
