import type { LinearClient, LinearIssue } from '../types.js';
import { env } from '../config.js';

const API = 'https://api.linear.app/graphql';

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      // Linear takes the raw key — no "Bearer" prefix. This trips everyone up once.
      Authorization: env.linearKey(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`Linear: ${json.errors.map((e) => e.message).join('; ')}`);
  if (!json.data) throw new Error(`Linear returned no data (HTTP ${res.status})`);
  return json.data;
}

export function makeLinearClient(): LinearClient {
  let cachedTeam: string | null = env.linearTeam();

  return {
    async teamId() {
      if (cachedTeam) return cachedTeam;
      const data = await gql<{ teams: { nodes: { id: string; name: string }[] } }>(
        `query { teams(first: 1) { nodes { id name } } }`,
      );
      const team = data.teams.nodes[0];
      if (!team) throw new Error('No Linear teams found for this API key.');
      cachedTeam = team.id;
      return team.id;
    },

    async createIssue({ title, description }) {
      const teamId = await this.teamId();
      const data = await gql<{
        issueCreate: { success: boolean; issue: LinearIssue | null };
      }>(
        `mutation Create($input: IssueCreateInput!) {
           issueCreate(input: $input) {
             success
             issue { id identifier url }
           }
         }`,
        { input: { teamId, title, description } },
      );

      if (!data.issueCreate.success || !data.issueCreate.issue) {
        throw new Error('Linear issueCreate returned success=false');
      }
      return data.issueCreate.issue;
    },
  };
}
