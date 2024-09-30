const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("HELLO WORLD");
});

app.listen(3000, () => {
  console.log("Start server on port 3000");
});

// 参考
// https://qiita.com/reirei-python/items/0f34ab72d51473aff0f4

// Dockerfileからコンテナを作成/DockerfileからDockerImageを作成
// docker build -t express-image .

// Dockerfileからコンテナを作成/作成したImageからコンテナを立ち上げ
// docker container run -it --name express -p 3000:3000 -d express-image
