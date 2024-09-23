import * as os from "node:os";

// ユーザー名を取得
const userInfo = os.userInfo();
const username = userInfo.username;

export const envname = `hoge-${username}`;
