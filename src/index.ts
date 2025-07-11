import express from "express";
import * as dotenv from "dotenv";
import { checkForNewContests, checkForNewRatingActivity } from "./services";

dotenv.config();

const app = express();
const port = process.env.PORT || 3030;

//middleware
app.use(express.json());

checkForNewContests();
checkForNewRatingActivity();

app.listen(port, () => console.log(`Listening on port ${port}!`));
