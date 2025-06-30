import fs from "fs";
import axios from "axios";
import nodemailer from "nodemailer";
import { constants } from "../constants";
import { newContestTemplate } from "../template";

const transporter = nodemailer.createTransport({
    service: constants.mailServer.service,
    auth: {
        user: constants.mailServer.user,
        pass: constants.mailServer.pass,
    },
});

export const checkForNewContests = async () => {
    let lastSeenContestId = null;

    // load last ID
    if (fs.existsSync("lastContest.json")) {
        lastSeenContestId = JSON.parse(fs.readFileSync("lastContest.json", "utf-8")).id;
    }

    try {
        console.log("STARTED checking for new contests");
        const response = await axios.get(constants.atom.contestUrl || "", {
            headers: {
                Cookie: constants.atom.contestsCookies,
                'User-Agent': 'Mozilla/5.0',
            },
        });

        const html = response.data;

        // Search for the watching_contests list and extract the first contest ID
        // Only if it contains "Company Name" or "Tagline" in the contest type
        const watchingContestsMatch = html.match(/<ul class="content pull-left watching_contests">\s*<li[^>]*data-contest-id="([^"]+)"[^>]*>[\s\S]*?<div class="top clearfix">\s*<a href="([^"]+)">\s*([^<]+(?:\s*<span[^>]*>[^<]*<\/span>)?)\s*<\/a>[\s\S]*?<a[^>]*href="\/branding-marketing-naming-contests"[^>]*>Naming\s*<span>\/<\/span>\s*(Company Name|Tagline)\s*<\/a>/);
        const newestContestId = watchingContestsMatch ? watchingContestsMatch[1] : null;
        const contestUrl = watchingContestsMatch ? watchingContestsMatch[2] : null;
        const contestTitle = watchingContestsMatch ? watchingContestsMatch[3].replace(/<span[^>]*>[^<]*<\/span>/g, '').trim() : null;

        if (!newestContestId) return console.log('No contests found.');

        if (newestContestId !== lastSeenContestId) {
            console.log('New contest found:', newestContestId);
            console.log('Contest title:', contestTitle);
            console.log('Contest URL:', contestUrl);

            // Update cache
            fs.writeFileSync('lastContest.json', JSON.stringify({ id: newestContestId }));

            // Send email
            await transporter.sendMail({
                from: '"Atom Contest Notifier"',
                to: 'laxhameedhafeez@gmail.com',
                subject: '🚨 New Contest Alert!',
                text: `A new contest has been posted: ${contestTitle}\nURL: ${contestUrl}`,
                html: newContestTemplate(contestTitle, newestContestId, contestUrl),
            });

            console.log('New contest found:', newestContestId);
        } else {
            console.log('No new contest.');
        }
    } catch (err: any) {
        console.error('Error checking contests:', err.message);
    }
};

setInterval(checkForNewContests, Number(constants.atom.contestCheckInterval));
