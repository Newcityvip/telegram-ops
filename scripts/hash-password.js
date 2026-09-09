import {hash} from "bcryptjs";
import {createInterface} from "node:readline/promises";
const rl=createInterface({input:process.stdin,output:process.stdout});
const password=await rl.question("Password (input is visible): ");rl.close();
if(password.length<12)throw Error("Use at least 12 characters");
console.log(await hash(password,12));
