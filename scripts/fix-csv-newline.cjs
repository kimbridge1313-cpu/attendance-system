const fs = require("fs");

const filePath = "src/App.jsx";
let source = fs.readFileSync(filePath, "utf8");

source = source.replace(/\.join\("\r?\n"\);/g, '.join("\\n");');

fs.writeFileSync(filePath, source, "utf8");
