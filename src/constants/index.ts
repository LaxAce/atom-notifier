import * as dotenv from "dotenv";
dotenv.config();

export const constants = {
    port: process.env.PORT,
    mailServer: {
        pass: process.env.PASS,
        user: process.env.USER_ID,
        service: process.env.SERVICE,
    },
    atom: {
        contestUrl: process.env.CONTEST_URL,
        contestsCookies: process.env.CONTEST_COOKIES,
        activityFieldUrl: process.env.ACTIVITY_FIELD_URL,
        contestCheckInterval: process.env.CONTEST_CHECK_INTERVAL,
        activityFieldCookies: process.env.ACTIVITY_FIELD_COOKIES,
        activityCheckInterval: process.env.ACTIVITY_CHECK_INTERVAL,
    }
}
