import fs from "fs";
import axios from "axios";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { constants } from "../constants";
import { newActivityTemplate, newContestTemplate } from "../template";

const transporter = nodemailer.createTransport({
    service: constants.mailServer.service,
    auth: {
        user: constants.mailServer.user,
        pass: constants.mailServer.pass,
    },
});

const getActivityKeyFromFields = (ratingType: string, submission: string, contestUrl: string) => {
    return crypto.createHash('sha256').update(`${ratingType}|${submission}|${contestUrl}`).digest('hex');
}

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
                to: constants.mailServer.user,
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

export const checkForNewRatingActivity = async () => {
    let lastSeenActivityKey: string | null = null;
    // Load last activity date
    if (fs.existsSync("mostRecentActivity.json")) {
        lastSeenActivityKey = JSON.parse(fs.readFileSync("mostRecentActivity.json", "utf-8")).id;
    }

    try {
        console.log("STARTED checking for new rating activity");
        const response = await axios.get(constants.atom.activityFieldUrl || "", {
            headers: {
                Cookie: constants.atom.activityFieldCookies,
                'User-Agent': 'Mozilla/5.0',
            },
        });

        const html = response.data;

        const mostRecentMatch = html.match(/<div class="timeline-item">([\s\S]*?)<\/div>/);
        const mostRecentHtml = mostRecentMatch ? mostRecentMatch[0] : null;

        const ratingTypeMatch = mostRecentHtml.match(/<p[^>]*>([^<]+)<\/p>/);
        const ratingType = ratingTypeMatch ? ratingTypeMatch[1].trim() : "";

        const submissionMatch = mostRecentHtml.match(/<b>"([^"]+)"<\/b>/);
        const submission = submissionMatch ? submissionMatch[1].trim() : "";

        const contestUrlMatch = mostRecentHtml.match(/<a href="([^"]+)"/);
        const contestUrl = contestUrlMatch ? contestUrlMatch[1].trim() : "";

        if (!mostRecentHtml) return console.log('No activity found.');

        const mostRecentActivityKey = getActivityKeyFromFields(ratingType, submission, contestUrl);

        if (mostRecentActivityKey !== lastSeenActivityKey) {
            console.log('New activity found:', mostRecentActivityKey);

            // Update cache
            fs.writeFileSync('mostRecentActivity.json', JSON.stringify({ id: mostRecentActivityKey }));

            // Send email
            await transporter.sendMail({
                from: '"Atom Activity Notifier"',
                to: constants.mailServer.user,
                subject: '🚨 New Rating Activity Alert!',
                text: `A new rating activity was detected.`,
                html: newActivityTemplate(ratingType, submission, contestUrl),
            });

            console.log('New activity found:', mostRecentActivityKey);
        } else {
            console.log('No new activity...');
        }
    } catch (err: any) {
        console.error('Error checking activity:', err.message);
    }
};

// TODO: remove this after test - github action is taking care of this now
// setInterval(checkForNewContests, Number(constants.atom.contestCheckInterval));
// setInterval(checkForNewRatingActivity, Number(constants.atom.activityCheckInterval));
