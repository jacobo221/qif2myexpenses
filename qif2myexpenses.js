/**
 * Setup
 **/

const default_currency              = 'EUR';
const default_account_type          = 'CASH';
const default_transaction_status    = 'UNRECONCILED';
const qif_filename                  = 'export.qif';
const db_template_filename          = 'template.db';
const pref_filename                 = 'BACKUP_PREF';
const db_filename                   = 'BACKUP';
const output_filename               = 'BACKUP.zip';
const progress                      = true;
const debug                         = false;

/**
 * Global variables
 **/

const sqlite3   = require('sqlite3');
const fs        = require('fs');
const crypto    = require('crypto');
const path      = require('path');
const zip       = require('adm-zip');

var db;

// Here we will store transactions that need to be updated once the matching transaction is reached (for transfers)
const transfers_waiting_for_peer = {};

// Map of cached ids
const ids_map       = {
    accounts:   {},
    categories: {},
    payees:     {},
}

// Map of type of each account
const accounts_type = {};

/**
 * Logic layer
 **/

class Entry {

    constructor(def, db_table, db_columns) {

        // We do not want Annotation objects to be created directly
        this.lock_annotation();

        this.db_table   = db_table;
        this.db_columns = db_columns;

        this.def        = def; // Keep in case it is needed, for example for Transfer.get_peer_transfer

        // Set object properties
        this.qif2db(def);

        // Generate a different random UUID for each transaction
        if (this.uuid === undefined) this.uuid = this.#new_uuid();

    }

    async db_insert() {

        // Insert the object in the DB
        return this._id = await this.#insert();


    }

    async db_update() {

        // Update the object in the DB
        await this.#update();

    }


    // Dummies to be overloaded in sub-classes

    // Lock so we can cannot create objects directly from this class
    lock_annotation() { throw new Error('Objects of this class cannot be created directly, use a sub-class'); }

    qif2db() {} // Dummy method, must be overwritten in sub-classes


    // Private methods

    // Generate a new UUID which is unique among all the UUIDs generated in this run
    #new_uuid() {

        // Keep a list of generated UUIDs between calls, so we don't duplicate any
        if (!this.uuids) this.uuids = [];

        // Generate UUIDs until we find one that hasn't been used before
        let uuid;
        while (this.uuids.includes(uuid = crypto.randomUUID()));

        return uuid;

    }

    async #insert() {

        const sql = 'INSERT INTO ' + this.db_table + ' (' +
                this.db_columns.map(column => '`' + column + '`').join(', ') +
            ') values (' +
                this.db_columns.map(column => this[column] !== undefined ? (typeof this[column] == 'string' ? '\'' + this[column].replace(/\'/g, '\'\'') + '\'' : this[column]) : 'NULL').join(', ') +
            ')';

        if (debug) console.log(this);
        if (debug) console.log(sql);

        return new Promise(resolve => {
            return db.run(
                sql,
                [],
                function (err) { // Cannot be a lambda function, otherwise lastID is unaccessible

                    if (err) throw err;

                    if (debug) console.log("ID: " + this.lastID);
                    resolve(this.lastID);
                }
            );
        });

    }

    async #update() {

        const sql = 'UPDATE ' + this.db_table + ' SET ' +
                this.db_columns.map(column => column + '=' + (this[column] !== undefined ? (typeof this[column] == 'string' ? '\'' + this[column].replace(/\'/g, '\'\'') + '\'' : this[column]) : 'NULL')).join(', ') +
            ' WHERE _id = ' + this._id;

        if (debug) console.log(this);
        if (debug) console.log(sql);

        return new Promise(resolve => {
            return db.run(
                sql,
                [],
                err => {

                    if (err) throw err;

                    resolve();
                }
            );

        });
    }

}

class Account extends Entry {

    convert_account_type(type) {

        if (!type)
            return default_account_type; // Default value

        else if (type == 'Cash')
            return 'CASH';
        else if (type == 'Bank')
            return 'BANK';
        else if (type == 'CCard')
            return 'CCARD';
        else if (type == 'Oth L')
            return 'LIABILITY';
        else if (type == 'Oth A' || type == 'Invst')
            return 'ASSET';

        // We do not parse Invoice from QIF files as we cannot guess which type to use

        else throw new Error(`Unknown account type: ${type}`);

    }

    lock_annotation() {} // Remove lock so we can create objects from this sub-class

    constructor(def) {

        if (![ 'fullname' ].every(column => def[column] !== undefined)) throw new Error('Invalid QIF format: Account is missing a mandatory field');

        def.name = def.fullname; // MyExpsense does not support sub-accounts
        if (!def.name) throw new Error('Invalid QIF format: Account is missign a name');

        // Check if it already exists. If it does, return cached id
        if (ids_map.accounts[def.fullname] !== undefined) throw new Error('Cannot create the account category twice');

        super(def, 'accounts', [
            '_id',
            'label',
            'opening_balance',
            'description',
            'currency',
            'type',
            'last_used',
            'sort_key',
            'uuid',
            'criterion',
        ]);

    }

    async db_insert() {

        accounts_type[this.label] = this.type;
        return ids_map.accounts[this.label] = await super.db_insert();

    }

    qif2db(def) {

        // _id is generated by db when insert() is run

        this.label              = def.name;

        this.opening_balance    = 0;

        this.description        = def.description;

        this.currency           = default_currency;

        this.type               = this.convert_account_type(def.type);

        this.last_used          = 0;

        this.sort_key           = Object.keys(ids_map.categories).length + 1;

        this.criterion          = 0;

    }

}

class Category extends Entry {

    lock_annotation() {} // Remove lock so we can create objects from this sub-class

    constructor(def) {

        if (![ 'fullname' ].every(column => def[column] !== undefined)) throw new Error('Invalid QIF format: Category is missing a mandatory field');

        // Check if it already exists. If it does, return cached id
        if (ids_map.categories[def.fullname] !== undefined) throw new Error('Cannot create the same category twice');

        def.name = def.fullname.includes(':') ? def.fullname.split(':').pop() : def.fullname;
        if (!def.name) throw new Error('Invalid QIF format: Account is missign a name');

        super(def, 'categories', [
            '_id',
            'label',
            'label_normalized',
            'parent_id',
            'last_used',
            'icon',
            'uuid',
        ]);

        this.fullname = def.fullname;

    }

    async db_insert() {

        if (this.fullname.includes(':')) {
            
            const hierarchy = this.fullname.split(':');
            const parent_fullname = hierarchy.slice(0, -1).join(':');
            const parent_def = Object.assign({}, this.def, { fullname: parent_fullname });
            this.parent_id = await getOrCreateEntryIdByName(Category, parent_def);

        }

        return ids_map.categories[this.fullname] = await super.db_insert();
        
    }

    qif2db(def) {

        // _id is generated by db when insert() is run

        this.label              = def.name;

        this.label_normalized   = this.label.toLowerCase();

        this.parent_id          = def.parent_id;

        this.currency           = default_currency;

        this.last_used          = 0;

        this.icon               = '';
        
        if (def.parent_id === undefined) this.color = Math.floor(Math.random() * 255 * 255 * 255);

    }

}

class Payee extends Entry {

    lock_annotation() {} // Remove lock so we can create objects from this sub-class

    constructor(def) {

        if (![ 'fullname' ].every(column => def[column] !== undefined)) throw new Error('Invalid QIF format: Payee is missing a mandatory field');

        def.name = def.fullname; // MyExpsense does not support sub-payees
        if (!def.name) throw new Error('Invalid QIF format: Payee is missign a name');

        // Check if it already exists. If it does, return cached id
        if (ids_map.payees[def.fullname] !== undefined) throw new Error('Cannot create the same payee twice');

        super(def, 'payee', [
            '_id',
            'name',
            'name_normalized',
        ]);

    }

    async db_insert() {

        return ids_map.payees[this.name] = await super.db_insert();
        
    }

    qif2db(def) {

        // _id is generated by db when insert() is run

        this.name              = def.name;

        this.name_normalized   = this.name.toLowerCase();

    }

}

class Annotation extends Entry {

    convert_cleared_status(cleared_status, account_type) {

        if (!cleared_status)
            return account_type == 'CASH' ? 'UNRECONCILED' : default_transaction_status; // Default value. Transactions in cash accounts can only be unreconciled

        else if (cleared_status == '*' || cleared_status == 'c')
            return 'CLEARED';
        else if (cleared_status == 'X' || cleared_status == 'R')
            return 'RECONCILED';
        // QIF does not support VOID

        else throw new Error(`Unknown cr_status: ${cleared_status}`);

    }

    constructor(def, db_table) {

        if (![ 'date', 'amount_float', 'account_id' ].every(column => def[column] !== undefined)) throw new Error('Invalid QIF format: Annotation is missing a mandatory field');

        super(def, 'transactions', [
            '_id',
            'comment',
            'date',
            'value_date',
            'amount',
            'cat_id',
            'account_id',
            'payee_id',
            'transfer_peer',
            'transfer_account',
            'method_id',
            'parent_id',
            'cr_status',
            'number',
            'picture_id',
            'uuid',
            'original_amount',
            'original_currency',
            'equivalent_amount',
            'debt_id',
        ]);

    }

    qif2db(def) {

        // _id is generated by db when insert() is run

        this.comment            = def.memo;

        this.date               = parseInt(new Date(def.date).getTime() / 1000); // QIF format is MM/dd/yyyy
        this.value_date         = def.value_date !== undefined ? def.value_date : this.date;

        this.amount             = parseInt((def.amount_float * 100).toPrecision(12)); // toPrecision is necessary to fix the floating point calculations innaccuracy in javascript

        this.cat_id             = def.cat_id;
        this.account_id         = def.account_id;
        this.payee_id           = def.payee_id;

        if (def.transfer_peer)            this.transfer_peer      = def.transfer_peer;

        this.transfer_account   = def.transfer_account;

        this.method_id          = undefined; // Unsupported by QIF

        if (def.parent_id)                this.parent_id          = def.parent_id;

        this.cr_status          = this.convert_cleared_status(def.cleared_status, accounts_type[def.account_id]);

        this.number             = def.check_number;

        this.picture_id         = undefined; // Unsupported by QIF
        this.original_amount    = undefined; // Unsupported by QIF
        this.original_currency  = undefined; // Unsupported by QIF
        this.equivalent_amount  = undefined; // Unsupported by QIF
        this.debt_id            = undefined; // Unsupported by QIF
        
        if (def.uuid)                     this.uuid               = def.uuid;

    }

}

class Transaction extends Annotation {

    lock_annotation() {} // Remove lock so we can create objects from this sub-class

    constructor(def) {

        super(def);

    }

}

class Transfer extends Annotation {

    lock_annotation() {} // Remove lock so we can create objects from this sub-class

    constructor(def) {

        if (![ 'transfer_account' ].every(column => def[column] !== undefined)) throw new Error('Invalid QIF format: Transfer is missing a mandatory field');

        // For transfers, once we reach the matching transfer we need to update the transfer_peer field
        // Check if this is the matching annotation of a transfer already registered transfer
        const matching_peer_transfer_key = Transfer.get_peer_transfer_key(def, true);
        const matching_peer_transfers = transfers_waiting_for_peer[matching_peer_transfer_key];
        if (matching_peer_transfers) {

            const matching_peer_transfer = matching_peer_transfers[matching_peer_transfers.length - 1];

            // Update this annotation with the peer transfer annotation's id and uuid, and split parent if it was the case

            def.transfer_peer = matching_peer_transfer._id;
            def.uuid = matching_peer_transfer.uuid;

            super(def);

        } else {

            // This is the first annotation of the transfer. Add it to the transfers waiting for peer list

            super(def);

            const this_peer_transfer_key = Transfer.get_peer_transfer_key(def, false);
            const this_peer_transfer = transfers_waiting_for_peer[this_peer_transfer_key];
            if (!this_peer_transfer) transfers_waiting_for_peer[this_peer_transfer_key] = [];
            transfers_waiting_for_peer[this_peer_transfer_key].push(this);

        }

    }

    async db_insert() {

        const id = await super.db_insert();

        const matching_peer_transfer_key = Transfer.get_peer_transfer_key(this.def, true);
        const matching_peer_transfers = transfers_waiting_for_peer[matching_peer_transfer_key];
        if (matching_peer_transfers) {

            const matching_peer_transfer = matching_peer_transfers.pop();

            // Update the peer transfer annotation with this annotation's id

            matching_peer_transfer.transfer_peer = id;
            await matching_peer_transfer.db_update();
            
            // Clear the transfer from the waiting list, so if there were several identical transfers each gets its rightful peer
            if (matching_peer_transfers.length === 0) delete transfers_waiting_for_peer[matching_peer_transfer_key];

        }

    }

    static get_peer_transfer_key(def, get_peer_key = false) {

        return (get_peer_key ?
                [ 'transfer_account', 'account_id' ]
            :
                [ 'account_id', 'transfer_account' ]
            )
            .concat([ 'date', 'amount_float', 'cat_id', 'memo' ]) // Leave comment for last as its content could be ambiguous with the other fields
            .map(key => key == "amount_float" && get_peer_key ?
                def[key] * -1
            :
                def[key]
            )
            .join('_');

    }

}

class Split extends Annotation {

    lock_annotation() {} // Remove lock so we can create objects from this sub-class

    constructor(def) {

        if (![ 'parent_id' ].every(column => def[column] !== undefined)) throw new Error('Invalid QIF format: Split is missing a mandatory field');

        super(def);

    }

}

class SplitTransfer extends Transfer {

    lock_annotation() {} // Remove lock so we can create objects from this sub-class

    constructor(def) {

        if (![ 'parent_id' ].every(column => def[column] !== undefined)) throw new Error('Invalid QIF format: SplitTransfer is missing a mandatory field');

        super(def);

    }

}

function classNameToMapProperty(def_class) {

    return def_class == 'Account' ? 'accounts' : (def_class == 'Category' ? 'categories' : (def_class == 'Payee' ? 'payees' : undefined));

}

async function getOrCreateEntryIdByName(def_class, defOrFullname) {

    let def, fullname;
    if (typeof defOrFullname == 'string') {
        fullname = defOrFullname;
        def = {};
        if (def_class == 'Payee')   def.name        = defOrFullname;
        else                        def.fullname    = defOrFullname;
    } else {
        def = defOrFullname;
        fullname = def.fullname || def.name;
    }

    if (typeof def_class == "function") def_class = def_class.name;

    const ids_map_property = classNameToMapProperty(def_class);
    if (!ids_map_property) throw new Error(`Tried to map id for invalid object class ${def_class}`);

    let id;
    if ((id = ids_map[ids_map_property][fullname]) === undefined) {
        const entry = eval('new ' + def_class + '(' + JSON.stringify(def) + ')');
        id = await entry.db_insert();
    }

    return id;

}


// Run
(async () => {

    // Pre-run checks

    // Check if necessary files exists
    [ qif_filename, db_template_filename ].forEach(filename => {
        if (!fs.existsSync(filename)) {
            console.error(`Missing file: ${filename}`);
            if (filename == qif_filename) console.log('For example, in anMoney, you can generate the QIF file by clicking on the menu > Export from book > File format: Microsoft Money QIF, Create a single file: Checked, Transaction status: All transactions, Export splits: Checked, Accounts: Select all. Rename the resulting file to \'export.qif\' and place it in the same directory as this script.');
            process.exit(1);
        }
    });

    // Check there is no db output file already, we do not want to overwrite it
    [ output_filename ].forEach(filename => {
        if (fs.existsSync(filename)) {
            console.error(`Output file already exists. Please remove, for safety reasons this program does not overwrite the file: ${filename}`);
            process.exit(1);
        }
    });

    // Copy template to output file
    fs.copyFile(db_template_filename, db_filename, err => { if (err) throw err; });

    // Generate the DB

    db = new sqlite3.Database(db_filename);

    // Clear database
    await new Promise(r => db.run('DELETE FROM transactions',               [], (err) => { if (err) throw err; r(); }));
    await new Promise(r => db.run('DELETE FROM debts',                      [], (err) => { if (err) throw err; r(); }));
    await new Promise(r => db.run('DELETE FROM budgets',                    [], (err) => { if (err) throw err; r(); }));
    await new Promise(r => db.run('DELETE FROM templates',                  [], (err) => { if (err) throw err; r(); }));
    await new Promise(r => db.run('DELETE FROM categories WHERE _id > 0',   [], (err) => { if (err) throw err; r(); }));
    await new Promise(r => db.run('DELETE FROM payee',                      [], (err) => { if (err) throw err; r(); }));
    await new Promise(r => db.run('DELETE FROM accounts',                   [], (err) => { if (err) throw err; r(); }));

    // Find accounts, payees and categories and create them
    // It is mandatory to search for accounts before parsing annotations since there is no other way to distinguish accounts from categories in the QIF format's annotations
    let skip = true;
    let def;
    let lines = fs.readFileSync(qif_filename, 'utf-8').split(/\r?\n/);
    for (let i in lines) {

        const line = lines[i];

        if (line == '') continue;

        if (skip) {

            if (debug) console.log(`Line ${i} Skip: ${line}`);
        
            if (line == '!Account') {
                def = {
                    class: 'Account',
                    parsed_fields: '',
                };
                skip = false;

            } else if (line == '!Type:Cat') {
                def = {
                    class: 'Category',
                    parsed_fields: '',
                };
                skip = false;

            } else {
                continue; // Skip, we are looking for the next Account or Category definition

            }

        } else {

            const key = line.charAt(0);
            const value = line.substring(1);

            if (debug) console.log(`Line ${i} Read: ${line}. ${key}: ${value}`);

            // Registers should contain a maximum of one of each field
            if (def.parsed_fields.includes(key)) throw new Error(`Invalid QIF format: Duplicate account or category field ${key} in ${def.type}`);

            // Store the field values
            if (key == 'N') {
                def.fullname = value;
                if (Object.keys(ids_map.accounts).includes(def.fullname) || Object.keys(ids_map.categories).includes(def.fullname)) throw new Error(`Invalid QIF format: Duplicate account or category name ${def.fullname}`);
                def.parsed_fields += key;

            } else if (key == 'T') {
                if (def.class != 'Account') throw new Error(`Invalid QIF format: Found type in object of type ${def.type}`);
                def.type = value;
                if (![ 'Cash', 'Bank', 'CCard', 'Invst', 'Oth A', 'Oth L', 'Invoice' ].includes(def.type)) throw new Error(`Invalid QIF format: Found invalid type account ${def.type}`);
                def.parsed_fields += key;

            } else if (key == 'D') {
                def.description = value;
                def.parsed_fields += key;

            // Process the account or category
            } else if (line == '^') {

                const ids_map_property = classNameToMapProperty(def.class);
                if (!ids_map_property) throw new Error(`Tried to map id for invalid object class ${def.class}`);

                if (ids_map[ids_map_property][def.fullname] !== undefined) throw new Error(`Invalid QIF format: Duplicate account definition for ${def.fullname}`);

                const entry = eval('new ' + def.class + '(' + JSON.stringify(def) + ')');
                await entry.db_insert();

                skip = true; // Mark the object definition as finished, so if the next line is not a header we can detect the QIF file is wrongly formated

            }

        }

    };

    if (debug) console.log(ids_map.accounts);

    if (!skip) throw new Error('Invalid QIF format: Found header before closing previous register');

    // Check if we need to move on to the next Split annotation. If so, submit the current annotation
    async function check_split_submit(def, key) {
        let split_def, split_parent_id;
        if (!def.class || !def.class.startsWith('Split') || def.parsed_fields.includes(key)) {
            if (!def.class || !def.class.startsWith('Split')) {
                if (!def.class) def.class = 'Transaction';
                def.cat_id = 0;
                const entry = eval('new ' + def.class + '(' + JSON.stringify(def) + ')');
                split_parent_id = await entry.db_insert();
            } else {
                const entry = eval('new ' + def.class + '(' + JSON.stringify(def) + ')'); // Keep the parent_id from the previous Split annotation
                await entry.db_insert();
                split_parent_id = def.parent_id;
            }
            split_def = {
                class: 'Split', // Assume it is a Split annotation, we might need to update later to become a SplitTransfer
                parent_id: split_parent_id,
                parsed_fields: '',
                date: def.date,
                value_date: 0,
                account_id: def.account_id,
            };
        } else {
            split_def = def;
        }
        return split_def;
    }

    // Parse all annotations
    skip = false;
    def = { parsed_fields: '' };
    let last_account_id;
    lines = fs.readFileSync(qif_filename, 'utf-8').split(/\r?\n/);
    for (let i in lines) {

        if (progress && i % 100 === 0) console.log(`${i} of ${lines.length - 1}`);

        const line = lines[i];

        if (line == '') continue;

        if (skip) {

            if (debug) console.log(`Line ${i} Skip: ${line}`);
        
            if (line == '!Account') {
                skip = 'listen for account name';

            } else if (line == '^') {
                skip = false;
                def = {
                    parsed_fields: '',
                    account_id: last_account_id,
                };

            } else if (line.startsWith('N') && skip == 'listen for account name') {
                const last_account_name = line.substring(1);
                last_account_id = ids_map.accounts[last_account_name];
                if (last_account_id === undefined) throw new Error(`Invalid QIF file: Unknown account ${last_account_name}`);


            } else {
                continue; // Skip, we are looking for the next Annotation

            }

        } else {

            const key = line.charAt(0);
            let value = line.substring(1);

            if (debug) console.log(`Line ${i} Read: ${line}. ${key}: ${value}`);

            // Registers should contain a maximum of one of each field
            if ((!def.class || !def.class.startsWith('Split')) && def.parsed_fields.includes(key)) throw new Error(`Invalid QIF format: Duplicate annotation field ${key} in ${def.type} - ${def.class}`);

            if (line == '!Account' || line == '!Type:Cat') {
                skip = line == '!Account' ? 'listen for account name' : true;
                last_account_id = undefined;

            } else if (line === '' || line.startsWith('!Type')) {
                continue; // Skip empty lines and redudant type lines (type is already defined in the account definition)

            } else if (key == 'D') {
                def.date = value;
                def.parsed_fields += key;

            } else if (key == 'T' || key == 'U') {
                def.amount_float = value;
                def.parsed_fields += key;

            } else if (key == 'M') {
                def.memo = value;
                def.parsed_fields += key;

            } else if (key == 'C') {
                def.cleared_status = value;
                def.parsed_fields += key;

            } else if (key == 'P') {
                def.payee_id = await getOrCreateEntryIdByName(Payee, value);
                def.parsed_fields += key;

            } else if (key == 'L') {
                if (value.charAt(0) == '[' && value.charAt(value.length -1) == ']') value = value.substring(1, value.length - 1);
                if ((def.transfer_account = ids_map.accounts[value]) !== undefined) {
                    def.class = 'Transfer';
                } else {
                    def.cat_id = await getOrCreateEntryIdByName(Category, value);
                    def.class = 'Transaction';
                }
                def.parsed_fields += key;

            } else if (key == 'N') {
                def.check_number = value;
                def.parsed_fields += key;

            // Store the field values
            } else if (key == 'S') {
                def = await check_split_submit(def, key);
                if (value.charAt(0) == '[' && value.charAt(value.length -1) == ']') value = value.substring(1, value.length - 1);
                if ((def.transfer_account = ids_map.accounts[value]) !== undefined) {
                    def.class = 'SplitTransfer';
                } else {
                    def.cat_id = await getOrCreateEntryIdByName(Category, value);
                }
                def.parsed_fields += key;

            } else if (key == 'E') {
                def = await check_split_submit(def, key);
                def.memo = value;
                def.parsed_fields += key;

            } else if (key == '$') {
                def = await check_split_submit(def, key);
                def.amount_float = value;
                def.parsed_fields += key;

            } else if (line == '^') {
                if (!def.class) throw new Error('Invalid QIF format: Undetermined class for annotation');
                if (last_account_id === undefined) throw new Error('Invalid QIF format: Undetermined account for annotation');
                const entry = eval('new ' + def.class + '(' + JSON.stringify(def) + ')');
                await entry.db_insert();
                def = {
                    parsed_fields: '',
                    account_id: last_account_id,
                };

            } else {
                throw new Error('Invalid QIF format: Undetermined field for annotation');

            }

            if (debug) console.log({def, last_account_id });

        }

    };

    if (skip) throw new Error('Invalid QIF format: Found annotation or header was not closed');

    db.close();

    if (Object.keys(transfers_waiting_for_peer).length > 0) {
        console.error('Error: All data was converted but some transfers have no matching annotation in the QIF file');
        if (debug) console.log(Object.keys(transfers_waiting_for_peer));
        return;
    }

    const zip_file = new zip();
    const pref_template_content =
        '<?xml version=\'1.0\' encoding=\'utf-8\' standalone=\'yes\' ?>' + '\n' +
        '<map>' + '\n' + 
        '\t' + '<int name="FEATURE_USAGES_SPLIT_TRANSACTION" value="0" />' + '\n' +
        '\t' + '<long name="FEATURE_SYNCHRONIZATION_FIRST_USAGE" value="1881864837725" />' + '\n' +
        '\t' + '<int name="FEATURE_USAGES_HISTORY" value="0" />' + '\n' +
        '\t' + '<int name="FEATURE_USAGES_DISTRIBUTION" value="0" />' + '\n' +
        '</map>';
    zip_file.addFile(pref_filename, Buffer.from(pref_template_content, 'utf8'));
    zip_file.addLocalFile(db_filename);
    zip_file.writeZip(output_filename);

    // Delete temporary files
    fs.unlinkSync(db_filename);

    console.log('Success! You can now restore the file ' + output_filename + ' in MyExpenses through Settings > Restore (ZIP)');

})();
