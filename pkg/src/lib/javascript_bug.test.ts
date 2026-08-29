import { prefixElementAttribute } from "./javascript.js";
const comp = {
  name: "MyComp",
  fileContent: `<span hidden class="active highlighted state-b"></span><script>box.classList.add(id("active"), id("highlighted"));</script>`,
  filePath: "test.html"
};
const res = prefixElementAttribute(comp, "class", "123", true);
console.log(res.fileContent);
