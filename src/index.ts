import * as dotenv from "dotenv";
import { checkForNewContests, checkForNewRatingActivity } from "./services";

dotenv.config();

checkForNewContests();
checkForNewRatingActivity();

