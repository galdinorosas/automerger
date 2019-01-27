const fs = require("fs");
const http = require("http");
// const githubWebhookHandler = require("github-webhook-handler");
const githubWebhookHandler = require("./components/github-webhook-handler/github-webhook-handler");
const Octokit = require("@octokit/rest");
const GITHUB_TOKEN = fs.readFileSync("config/github.token");
const octokit = new Octokit({
  auth: `token ${GITHUB_TOKEN}`
});
///////////////////////////////////////////////////////////////////////////////////////////////////
// Setup
///////////////////////////////////////////////////////////////////////////////////////////////////

const CONFIG = JSON.parse(fs.readFileSync("config.js"));

const HANDLER = githubWebhookHandler({
  path: CONFIG.github_webhook_path,
  secret: CONFIG.github_webhook_secret
});

///////////////////////////////////////////////////////////////////////////////////////////////////
// PR state representation
///////////////////////////////////////////////////////////////////////////////////////////////////

// PRs contains status about incomplete pr's:
// {
//     'https://api.github.com/repos/dgmltn/api-test/pulls/5': {
//         head_sha: 'abcd1234...',
//         ref: 'my-pull-request',
//         checks: {
//             'context1': true|false,
//             'context2': true|false
//         },
//         reviews: {
//             'user1': true|false,
//             'user2': true|false
//         },
//         mergeable: true|false
//     }
// }
var prs = {};

// commits references a pr url to a commit sha:
// {
//     'abcd1234...': 'https://github.com/dgmltn/api-test/pull/5',
// }
var commits = {};

///////////////////////////////////////////////////////////////////////////////////////////////////
// Webhook Handlers
///////////////////////////////////////////////////////////////////////////////////////////////////

http
  .createServer(function(req, res) {
    HANDLER(req, res, function(err) {
      res.statusCode = 404;
      res.end("no such location");
    });
  })
  .listen(CONFIG.port, () => console.log("listening on port 8080"));

HANDLER.on("error", function(err) {
  console.error("Error:", err.message);
});

HANDLER.on("issues", function(event) {
  console.log(
    "Received an issue event for %s action=%s: #%d %s",
    event.payload.repository.name,
    event.payload.action,
    event.payload.issue.number,
    event.payload.issue.title
  );
});

// https://developer.github.com/v3/activity/events/types/#pullrequestreviewevent
HANDLER.on("pull_request_review", function(event) {
  const url = event.payload.pull_request.url;
  const head_sha = event.payload.pull_request.head.sha;
  const ref = event.payload.pull_request.head.ref;
  console.log(url + " -> pull_request_review");
  console.log(head_sha + " -> head_sha pull_request_review");
  console.log(ref + " -> ref pull_request_review");
  ensurePr(url, head_sha);
  prs[url].ref = ref;
  populateMergeable(url);
  populateReviews(url);
  mergeIfReady(url);
});

// https://developer.github.com/v3/activity/events/types/#pullrequestevent
HANDLER.on("pull_request", function(event) {
  const url = event.payload.pull_request.url;
  const head_sha = event.payload.pull_request.head.sha;
  const ref = event.payload.pull_request.head.ref;

  console.log(url + " -> pull_request");
  console.log(head_sha + " -> head_sha pull_request");
  console.log(ref + " -> ref pull_request");
  ensurePr(url, head_sha);
  prs[url].ref = ref;
  populateMergeable(url);
  populateReviews(url);
  mergeIfReady(url);
});

// https://developer.github.com/v3/activity/events/types/#statusevent
HANDLER.on("status", function(event) {
  const sha = event.payload.sha;
  const context = event.payload.context;
  const state = event.payload.state;
  console.log(sha + " -> sha");
  console.log(context + " -> context");
  console.log(state + " -> state");
  console.log(commits + " -> commits");
  var success = false;
  switch (state) {
    case "success":
      success = true;
      break;
    case "pending":
    case "failure":
    case "error":
      // success = false, still
      break;
    default:
      console.error("Unknown check state '" + state + "'. success = false");
      break;
  }

  const processUrl = function(err, url) {
    if (err) {
      console.error(err);
      return;
    }

    console.log(url + " -> status");
    ensurePr(url, sha);
    prs[url].checks[context] = success;
    populateMergeable(url);
    populateReviews(url);
    mergeIfReady(url);
  };

  if (sha in commits) {
    processUrl(null, commits[sha]);
  } else {
    const owner = event.payload.repository.owner.login;
    const repo = event.payload.repository.name;
    lookupPullRequest(owner, repo, sha, processUrl);
  }
});

///////////////////////////////////////////////////////////////////////////////////////////////////
// Private helpers
///////////////////////////////////////////////////////////////////////////////////////////////////

// Initialize an empty pr
function ensurePr(url, head_sha) {
  if (!(url in prs)) {
    prs[url] = {};
  }
  if (!("head_sha" in prs[url]) || prs[url].head_sha != head_sha) {
    prs[url].head_sha = head_sha;
    prs[url].checks = {};
    prs[url].reviews = {};
    prs[url].mergeable = false;
  }
  commits[head_sha] = url;

  console.log("prs within ensurePR::", prs);
  console.log("commits within ensurePR::", commits);
}

// GET pull requests and check their mergeable status
function populateMergeable(url) {
  setTimeout(function() {
    const params = parsePullRequestUrl(url);
    octokit.pulls
      .get(params)
      .then(pr => {
        console.log("pr within populateMergeable::", pr);
        if (!(url in prs)) {
          console.error(url + " not found in prs hash");
          return;
        }
        prs[url].mergeable = !!pr.data.mergeable;
        // mergeIfReady(url);
        console.log("prs within populateMergeable::", prs);
        console.log("prs within populateMergeable for url of interest::", prs[url]);
      })
      .catch(err => {
        console.error("pr get request error: ", err);
      });
  }, 10000);
}

// GET pr reviews and check their approved status. Replace existing reviews.
function populateReviews(url) {
  console.log("populateReviews(" + url + ")");
  const params = parsePullRequestUrl(url);
  octokit.pulls
    .listReviews(params)
    .then(res => {
      if (!(url in prs)) {
        console.error(url + " not found in prs hash");
        return;
      }

      if ("data" in res) {
        res = res.data;
      }

      prs[url].reviews = {};

      for (var i in res) {
        console.log("i = " + i);
        var review = res[i];
        console.log("review = " + JSON.stringify(review, null, " "));
        var user = review.user.login;
        // Since reviews are returned in chronological order, the last
        // one found is the most recent. We'll use that one.
        var approved = review.state.toLowerCase() == "approved";
        prs[url].reviews[user] = approved;
      }

      console.log("prs within populateReviews::", prs);
      console.log("prs within populateReviews for url of interest::", prs[url]);

      // mergeIfReady(url);
    })
    .catch(err => {
      console.error("pr listReviews request error: ", err);
    });
}

// Perform a merge on this PR if:
// 1. it's mergeable
// 2. >1 reviews exist and all are approved
// 3. >1 checks exist and all passed
function mergeIfReady(url) {
  console.log(JSON.stringify(prs, null, 4));
  if (
    url in prs &&
    !prs[url].done &&
    isMergeable(prs[url]) &&
    isApproved(prs[url]) &&
    checksPassed(prs[url])
  ) {
    // APPROVED!
    prs[url].done = true;
    console.log("APPROVED (" + url + ")!");

    const deleteCallback = function(err, res) {
      if (err) {
        console.error("Error: could not delete ref: " + err);
        return;
      }
      delete prs[url];
      console.log("DELETED (" + url + ")!");
    };

    const mergeCallback = function(err, res) {
      if (err) {
        console.error("Error: could not merge: " + err);
        delete prs[url].done;
        return;
      }
      console.log("MERGED (" + url + ")!");

      if (CONFIG.delete_after_merge) {
        deleteReference(url, deleteCallback);
      }
    };

    mergePullRequest(url, mergeCallback);
  }
}

function mergePullRequest(url, callback) {
  if (!(url in prs)) {
    console.error(url + " not found in prs hash");
    return;
  }
  const params = parsePullRequestUrl(url);
  params.sha = prs[url].head_sha;
  octokit.pulls.merge(params).then(res => callback(null, res)).catch(err => callback(err, null));
}

function deleteReference(url, callback) {
  if (!(url in prs)) {
    console.error(url + " not found in prs hash");
    return;
  }
  let params = parsePullRequestUrl(url);
  delete params.number;
  params.ref = prs[url].ref;
  octokit.git
    .deleteRef(params)
    .then(res => callback(null, res))
    .catch(err => callback(err, null));
}

// Finds the PR URL associated with the given head SHA
function lookupPullRequest(owner, repo, sha, callback) {
  const params = {
    owner: owner,
    repo: repo
  };

  octokit.pulls
    .list(params)
    .then(res => {
      for (var i in res.data) {
        const pr = res.data[i];
        if (pr.head.sha == sha) {
          const url = pr.url;
          callback(null, url);
          return;
        }
      }
      callback(
        "PR not found: (" + owner + ", " + repo + ", " + sha + ")",
        null
      );
    })
    .catch(err => {
      console.log("err with pr get: " + err);
      callback(err, null);
    });
}

function parsePullRequestUrl(url) {
  const re = /^https?:\/\/([^\/]+)\/repos\/([^\/]+)\/([^\/]+)\/pulls\/(\d+)$/;
  const match = re.exec(url);
  console.log("match::", match);
  return {
    owner: match[2],
    repo: match[3],
    number: match[4]
  };
}

function isMergeable(obj) {
  return "mergeable" in obj && !!obj.mergeable;
}

function isApproved(obj) {
  if (!("reviews" in obj)) {
    return false;
  } else if (Object.keys(obj.reviews).length <= 0) {
    return false;
  }
  for (var id in obj.reviews) {
    if (!obj.reviews[id]) {
      return false;
    }
  }
  return true;
}

function checksPassed(obj) {
  if (!("checks" in obj)) {
    return false;
  } else if (Object.keys(obj.checks).length <= 0) {
    return false;
  }
  for (var context in obj.checks) {
    if (!obj.checks[context]) {
      return false;
    }
  }
  return true;
}
