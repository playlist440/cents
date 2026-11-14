# Third-party notices

Cents bundles or builds on the following work by others.

## Shipped in this repository

| Component | Where | Licence |
|---|---|---|
| [Preact](https://github.com/preactjs/preact) © Jason Miller | `frontend/js/vendor/preact-htm.js` | MIT |
| [htm](https://github.com/developit/htm) © Google Inc. | `frontend/js/vendor/preact-htm.js` | Apache-2.0 |

The full licence texts are in [`frontend/js/vendor/LICENSES.txt`](frontend/js/vendor/LICENSES.txt),
which is also served by the app.

## Data

The list of merchant category codes in `backend/cents/data/mcc.json` takes its code set from
[greggles/mcc-codes](https://github.com/greggles/mcc-codes) (Unlicense, public domain). The
Dutch labels and the mapping to categories were written for Cents.

Company and brand names in `backend/cents/data/merchants.json` are used only to recognise
payments on a bank statement. They belong to their respective owners; Cents is not affiliated
with any of them, nor with any bank.

## Installed when the container image is built

These are not in the repository; the image installs them from PyPI with their own licences:
FastAPI (MIT), Starlette (BSD-3-Clause), Pydantic (MIT), Uvicorn (BSD-3-Clause),
python-multipart (Apache-2.0), defusedxml (PSF-2.0), tzdata (Apache-2.0).
The base image is the official `python:3.12-slim`.
