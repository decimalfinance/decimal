# Decimal

Accounts payable with agents built into the work. Decimal reads each bill, flags what looks wrong and posts it to QuickBooks or Xero. A person checks every bill, and nothing reaches the books until it's approved.

## A bill comes in

![A bill is uploaded with the Upload a bill button, Decimal reads it, the total is traced to the page, and the bill is sent for approval](docs/readme/1-a-bill-comes-in.gif)

Upload a PDF or forward the email, and Decimal reads it as you watch. Click a figure to see where on the page it came from. Decimal says what it isn't sure of: here, the categories, since this is the vendor's first bill.

## A duplicate is caught

![An agent compares a copy with the bill that came in before it, recommends closing it, and a person closes it](docs/readme/2-a-duplicate-is-caught.gif)

An agent compares the two bills figure by figure, reads both documents and recommends what to do. Closing the copy is still a person's click.

<sub>7 synthetic pairs, three runs: 21 of 21 verdicts right.</sub>

## Figures that don't add up

![An agent finds the freight charge the reading missed, and a person adds it to the bill](docs/readme/3-figures-that-dont-add-up.gif)

An agent reads the document to find out why: here, a freight charge the reading left off. Code checks every figure it names before the correction is offered.

<sub>6 synthetic cases, three runs: every answer that came back was right.</sub>

## Who approves what

![An admin splits bills at $5,000 and puts an approver on each path](docs/readme/4-who-approves-what.gif)

Admins draw the rules: split by amount, vendor, Category or a vendor's first bill, and put people on each path.

## Approved means it's in the books

![An approver approves a bill from the Inbox and it is posted to Xero](docs/readme/5-approved-means-posted.gif)

The last approval posts the bill to QuickBooks or Xero with the invoice attached. This one went to Xero's Demo Company.

## Connect your books

![Decimal reads two years of a company's books in Xero, asks three questions, and the admin presses Go](docs/readme/6-connect-your-books.gif)

Setup is a conversation. Decimal reads 24 months of the books and asks about what it found: look-alike vendors, lines coded two ways, the closing date. Nothing posts until an admin presses Go.

<sub>18 scripted setups on made-up companies: 15 to 17 of 18 right on QuickBooks over five runs, 13 to 17 of 18 on Xero over three.</sub>

---

**Status.** Everything up to posting to the books is built. Paying the bill isn't built yet, and there is no hosted version. The GIFs were recorded on a made-up company with synthetic invoices.

**More.** Where the AI stops, how each agent was measured and what isn't built: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md). How the system is built: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

TypeScript, Express, PostgreSQL and React. Every AI call runs on Claude or OpenAI, Claude Haiku 5.5 by default.

Built by Zaid Khan ([@fuyofulo](https://github.com/fuyofulo)).
