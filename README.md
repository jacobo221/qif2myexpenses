# qif2myexpenses
This script converts a QIF with multiple accounts into a My Expenses backup which can be later imported into My Expenses.

My Expenses has a built-in QIF import feature, but only supports importing one account at a time, which may not be a reasonable option when you have dozens of accounts. If that is your casez this script is for you.

**IMPORTANT:** My Expenses deletes all its previous data when importing a backup. If you just want to add new data, please contact me.

## Compatibility

What does it import:
 - Accounts
 - Categories
 - Payees (Parties)
 - Transactions
 - Transfers
 - Splits
 
What does it *not* import:
 - Budgets
 - Plans
 - Currencies
 - Attached documents
 - App configuration
 - Anything not specified in the "What does it import?" section

## Installation

 1. Install NodeJS
 2. Download `qif2myexpenses.js` and `template.db` files into the same directory
 3. In the same directory where the `qif2myexpenses.js` file is run `npm install adm-zip sqlite3`

## Setup

Edit the `qif2myexpenses.js` file to set up the following behaviours:
 - `default_transaction_status`: Possible values are 'UNRECONCILED' (default), 'CLEARED', 'RECONCILED', 'VOID'
 - `default_currency`: Define the currency used. This is the currency that will be used for all transactions

## Instructions

 1. Generate a file called `export.qif` and place it in the same directory where the `qif2myexpenses.js` file is 
 2. Run `node qif2myexpenses.js` from the same directory where the `qif2myexpenses.js` file is 

## Help

If you need help installing or running, please contact me at jacobo221@gmail.com
