import { writeFile } from "node:fs/promises";

const token = process.env.GH_TOKEN;
const login = process.env.GITHUB_LOGIN ?? "Klastic";
if (!token) throw new Error("GH_TOKEN is required");

const request = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub request failed with ${response.status}`);
  return response.json();
};

const graphql = async (query, variables) => {
  const payload = await request("https://api.github.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (payload.errors?.length) {
    throw new Error(payload.errors.map(({ message }) => message).join("; "));
  }
  return payload.data;
};

const profile = await request(`https://api.github.com/users/${login}`);
const firstYear = new Date(profile.created_at).getUTCFullYear();
const currentYear = new Date().getUTCFullYear();
const contributionQuery = `
  query Contributions($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        restrictedContributionsCount
        contributionCalendar { totalContributions }
      }
    }
  }
`;

const yearlyCollections = await Promise.all(
  Array.from({ length: currentYear - firstYear + 1 }, (_, index) => firstYear + index).map(
    async (year) => {
      const now = new Date();
      const endOfYear = new Date(`${year}-12-31T23:59:59Z`);
      const data = await graphql(contributionQuery, {
        login,
        from: `${year}-01-01T00:00:00Z`,
        to: (endOfYear < now ? endOfYear : now).toISOString(),
      });
      return data.user.contributionsCollection;
    },
  ),
);

const totals = yearlyCollections.reduce(
  (summary, collection) => ({
    contributions: summary.contributions + collection.contributionCalendar.totalContributions,
    commits: summary.commits + collection.totalCommitContributions,
    restricted: summary.restricted + collection.restrictedContributionsCount,
  }),
  { contributions: 0, commits: 0, restricted: 0 },
);

const memberships = await request("https://api.github.com/user/memberships/orgs?per_page=100");
const owners = [
  login,
  ...memberships.filter(({ state }) => state === "active").map(({ organization }) => organization.login),
];
const commitSearch = new URL("https://api.github.com/search/commits");
commitSearch.searchParams.set(
  "q",
  `${owners.map((owner) => `owner:${owner}`).join(" ")} author:${login}`,
);
commitSearch.searchParams.set("per_page", "1");
const verifiedCommits = (await request(commitSearch)).total_count;

const number = new Intl.NumberFormat("en-US").format;
const privateLine = totals.restricted
  ? `${number(totals.restricted)} anonymized private contributions included`
  : "Private activity is included when GitHub retains it";
const svg = `
<svg width="540" height="188" viewBox="0 0 540 188" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title description">
  <title id="title">${login} lifetime GitHub activity</title>
  <desc id="description">${number(totals.contributions)} lifetime contributions, ${number(totals.restricted)} anonymized private contributions, and ${number(verifiedCommits)} verified commits.</desc>
  <style>
    .title { fill: #f0f6fc; font: 600 18px "Segoe UI", Ubuntu, sans-serif; }
    .label { fill: #8b949e; font: 400 13px "Segoe UI", Ubuntu, sans-serif; }
    .value { fill: #f0f6fc; font: 700 24px "Segoe UI", Ubuntu, sans-serif; }
    .note { fill: #8b949e; font: 400 12px "Segoe UI", Ubuntu, sans-serif; }
  </style>
  <rect x="0.5" y="0.5" width="539" height="187" rx="8" fill="#0d1117" stroke="#30363d"/>
  <text x="24" y="34" class="title">Lifetime GitHub activity</text>
  <text x="24" y="67" class="label">All contributions since ${firstYear}</text>
  <text x="24" y="96" class="value">${number(totals.contributions)}</text>
  <text x="206" y="67" class="label">Private contributions</text>
  <text x="206" y="96" class="value">${number(totals.restricted)}</text>
  <text x="374" y="67" class="label">Verified commits</text>
  <text x="374" y="96" class="value">${number(verifiedCommits)}</text>
  <line x1="24" y1="120" x2="516" y2="120" stroke="#21262d"/>
  <text x="24" y="145" class="note">${privateLine}</text>
  <text x="24" y="166" class="note">Verified commits cover accessible personal and organization repositories</text>
</svg>
`.trimStart();

await writeFile("github-lifetime.svg", svg);
console.log(JSON.stringify({ firstYear, currentYear, owners, verifiedCommits, ...totals }, null, 2));