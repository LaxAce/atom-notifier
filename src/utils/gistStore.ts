import axios from "axios";
import { constants } from "../constants";

const gistHeaders = {
    Authorization: `Bearer ${constants.gitHub.githubToken}`,
    "User-Agent": "atom-notifier",
};

export async function readStateFromGist(): Promise<{ lastContestId: string | null; lastActivityKey: string | null }> {
    try {
        console.log("=======", "gistUrl", constants.gitHub.gistUrl, "github-token", constants.gitHub.githubToken )
        const res = await axios.get(`${constants.gitHub.gistUrl}/${constants.gitHub.gistId}`, {
            headers: gistHeaders,
        });

        const content = res.data.files[constants.gitHub.gistName].content;
        return JSON.parse(content);
    } catch (err: any) {
        console.error("Failed to read state from Gist:", err.message);
        return { lastContestId: null, lastActivityKey: null };
    }
}

export async function writeStateToGist(state: { lastContestId?: string | null; lastActivityKey?: string | null }) {
    try {
        await axios.patch(
            `${constants.gitHub.gistUrl}/${constants.gitHub.gistId}`,
            {
                files: {
                    [constants.gitHub.gistName]: { content: JSON.stringify(state, null, 2) },
                },
            },
            { headers: gistHeaders }
        );
    } catch (err: any) {
        console.error("Failed to write state to Gist:", err.message);
    }
}
