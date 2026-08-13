# Screenshots

The main README references seven images from this directory. Capture them at a
desktop width (~1440px, browser zoom 100%) and save them here with these exact
filenames:

| Filename | View | How to reach it |
|---|---|---|
| `01-dashboard.png` | Dashboard | `/` — wait for the statistics cards to load |
| `02-explorer.png` | Explorer + SVG neighbourhood | `/explorer/Technology/PyTorch` — scroll so the radial graph is fully visible |
| `03-career-path.png` | Career Path | `/career-path` → choose **Python**; frame the `Python → Machine Learning → PyTorch → ML Engineer` route |
| `04-study-path.png` | Study Path | `/study-path` → choose **Python**; include one card with a course and one showing "No course in the graph teaches this yet" |
| `05-path-builder.png` | Path Builder | `/path-builder` → skills **Python** + **SQL**, target **ML Engineer**; frame the coverage line, gaps and learning route |
| `06-connection-explorer.png` | Connection Explorer | `/connections` → Skill **Git** → Company **Google**; include the path diagram and the hop list |
| `07-error-state.png` | Database-unavailable state | See below |

## Capturing the error state

Stop the API server (Ctrl+C in its terminal) and reload the dashboard. Within a
few seconds the page shows the "Database unavailable" card with a **Try again**
button, and the header dot reads "Database offline". Capture that, then restart
the server with `npm run dev`.

## Before committing

- No terminal windows, `.env` contents, password managers or personal browser
  tabs in frame.
- The URL bar may show `localhost` — that is fine; just make sure no credentials
  appear in it.
