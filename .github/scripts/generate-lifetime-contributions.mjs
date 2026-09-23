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
        totalPullRequestContributions
        totalPullRequestReviewContributions
        totalIssueContributions
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
      return { year, ...data.user.contributionsCollection };
    },
  ),
);

const totals = yearlyCollections.reduce(
  (summary, collection) => ({
    contributions: summary.contributions + collection.contributionCalendar.totalContributions,
    commits: summary.commits + collection.totalCommitContributions,
    pullRequests: summary.pullRequests + collection.totalPullRequestContributions,
    reviews: summary.reviews + collection.totalPullRequestReviewContributions,
    issues: summary.issues + collection.totalIssueContributions,
    restricted: summary.restricted + collection.restrictedContributionsCount,
  }),
  { contributions: 0, commits: 0, pullRequests: 0, reviews: 0, issues: 0, restricted: 0 },
);

const number = new Intl.NumberFormat("en-US").format;
const privateLine = totals.restricted
  ? `${number(totals.restricted)} anonymized private contributions included`
  : "Private activity is included when GitHub retains it";
const svg = `
<svg width="540" height="244" viewBox="0 0 540 244" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title description">
  <title id="title">${login} lifetime GitHub activity</title>
  <desc id="description">${number(totals.contributions)} GitHub credited lifetime contributions, including ${number(totals.restricted)} restricted private contributions. The visible breakdown has ${number(totals.commits)} commits, ${number(totals.pullRequests)} pull requests, ${number(totals.reviews)} reviews, and ${number(totals.issues)} issues.</desc>
  <style>
    .title { fill: #f0f6fc; font: 600 18px "Segoe UI", Ubuntu, sans-serif; }
    .label { fill: #8b949e; font: 400 13px "Segoe UI", Ubuntu, sans-serif; }
    .value { fill: #f0f6fc; font: 700 24px "Segoe UI", Ubuntu, sans-serif; }
    .note { fill: #8b949e; font: 400 12px "Segoe UI", Ubuntu, sans-serif; }
  </style>
  <rect x="0.5" y="0.5" width="539" height="243" rx="8" fill="#0d1117" stroke="#30363d"/>
  <text x="24" y="34" class="title">Lifetime GitHub activity</text>
  <text x="24" y="67" class="label">GitHub credited contributions since ${firstYear}</text>
  <text x="24" y="96" class="value">${number(totals.contributions)}</text>
  <text x="330" y="67" class="label">Restricted private activity included</text>
  <text x="330" y="96" class="value">${number(totals.restricted)}</text>
  <line x1="24" y1="120" x2="516" y2="120" stroke="#21262d"/>
  <text x="24" y="146" class="label">Visible commits</text>
  <text x="24" y="174" class="value">${number(totals.commits)}</text>
  <text x="154" y="146" class="label">Visible PRs</text>
  <text x="154" y="174" class="value">${number(totals.pullRequests)}</text>
  <text x="274" y="146" class="label">Visible reviews</text>
  <text x="274" y="174" class="value">${number(totals.reviews)}</text>
  <text x="404" y="146" class="label">Visible issues</text>
  <text x="404" y="174" class="value">${number(totals.issues)}</text>
  <text x="24" y="207" class="note">${privateLine}</text>
  <text x="24" y="228" class="note">Restricted former organization activity cannot be separated by contribution type</text>
</svg>
`.trimStart();

const chartWidth = 540;
const chartTop = 74;
const rowHeight = 27;
const barX = 70;
const barWidth = 390;
const maxContributions = Math.max(...yearlyCollections.map(({ contributionCalendar }) => contributionCalendar.totalContributions));
const historyRows = yearlyCollections.map((collection, index) => {
  const total = collection.contributionCalendar.totalContributions;
  const restricted = collection.restrictedContributionsCount;
  const visible = total - restricted;
  const visibleWidth = Math.round((visible / maxContributions) * barWidth);
  const restrictedWidth = Math.round((restricted / maxContributions) * barWidth);
  const y = chartTop + index * rowHeight;
  return `
  <text x="24" y="${y + 13}" class="year">${collection.year}</text>
  <rect x="${barX}" y="${y}" width="${visibleWidth}" height="17" rx="3" fill="#58a6ff"/>
  <rect x="${barX + visibleWidth}" y="${y}" width="${restrictedWidth}" height="17" rx="3" fill="#bc8cff"/>
  <text x="${chartWidth - 24}" y="${y + 13}" text-anchor="end" class="count">${number(total)}</text>`;
}).join("");
const historyHeight = chartTop + yearlyCollections.length * rowHeight + 22;
const historySvg = `
<svg width="${chartWidth}" height="${historyHeight}" viewBox="0 0 ${chartWidth} ${historyHeight}" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title description">
  <title id="title">${login} contribution history by year</title>
  <desc id="description">GitHub credited contributions for each year from ${firstYear} through ${currentYear}. Blue activity is visible to the workflow and purple activity is restricted private activity.</desc>
  <style>
    .title { fill: #f0f6fc; font: 600 18px "Segoe UI", Ubuntu, sans-serif; }
    .year, .count, .legend { fill: #c9d1d9; font: 400 12px "Segoe UI", Ubuntu, sans-serif; }
  </style>
  <rect x="0.5" y="0.5" width="${chartWidth - 1}" height="${historyHeight - 1}" rx="8" fill="#0d1117" stroke="#30363d"/>
  <text x="24" y="34" class="title">Contribution history by year</text>
  <rect x="24" y="48" width="12" height="12" rx="2" fill="#58a6ff"/>
  <text x="42" y="58" class="legend">Visible</text>
  <rect x="108" y="48" width="12" height="12" rx="2" fill="#bc8cff"/>
  <text x="126" y="58" class="legend">Restricted private</text>
  ${historyRows}
</svg>
`.trimStart();

await Promise.all([
  writeFile("github-lifetime.svg", svg),
  writeFile("github-history.svg", historySvg),
]);
console.log(JSON.stringify({ firstYear, currentYear, totals, years: yearlyCollections.map((collection) => ({
  year: collection.year,
  contributions: collection.contributionCalendar.totalContributions,
  restricted: collection.restrictedContributionsCount,
  commits: collection.totalCommitContributions,
  pullRequests: collection.totalPullRequestContributions,
  reviews: collection.totalPullRequestReviewContributions,
  issues: collection.totalIssueContributions,
})) }, null, 2));
