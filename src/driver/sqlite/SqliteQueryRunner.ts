import {QueryRunner} from "../QueryRunner";
import {ObjectLiteral} from "../../common/ObjectLiteral";
import {Logger} from "../../logger/Logger";
import {DatabaseConnection} from "../DatabaseConnection";
import {TransactionAlreadyStartedError} from "../error/TransactionAlreadyStartedError";
import {TransactionNotStartedError} from "../error/TransactionNotStartedError";
import {SqliteDriver} from "./SqliteDriver";
import {DataTypeNotSupportedByDriverError} from "../error/DataTypeNotSupportedByDriverError";
import {IndexMetadata} from "../../metadata/IndexMetadata";
import {ColumnSchema} from "../../schema-builder/ColumnSchema";
import {ColumnMetadata} from "../../metadata/ColumnMetadata";
import {TableMetadata} from "../../metadata/TableMetadata";
import {TableSchema} from "../../schema-builder/TableSchema";
import {IndexSchema} from "../../schema-builder/IndexSchema";
import {ForeignKeySchema} from "../../schema-builder/ForeignKeySchema";
import {PrimaryKeySchema} from "../../schema-builder/PrimaryKeySchema";
import {UniqueKeySchema} from "../../schema-builder/UniqueKeySchema";
import {QueryRunnerAlreadyReleasedError} from "../error/QueryRunnerAlreadyReleasedError";
import {NamingStrategyInterface} from "../../naming-strategy/NamingStrategyInterface";

/**
 * Runs queries on a single sqlite database connection.
 */
export class SqliteQueryRunner implements QueryRunner {

    // -------------------------------------------------------------------------
    // Protected Properties
    // -------------------------------------------------------------------------

    /**
     * Indicates if connection for this query runner is released.
     * Once its released, query runner cannot run queries anymore.
     */
    protected isReleased = false;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(protected databaseConnection: DatabaseConnection,
                protected driver: SqliteDriver,
                protected logger: Logger) {
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Releases database connection. This is needed when using connection pooling.
     * If connection is not from a pool, it should not be released.
     */
    release(): Promise<void> {
        if (this.databaseConnection.releaseCallback) {
            this.isReleased = true;
            return this.databaseConnection.releaseCallback();
        }

        return Promise.resolve();
    }

    /**
     * Removes all tables from the currently connected database.
     */
    async clearDatabase(): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        const selectDropsQuery = `select 'drop table ' || name || ';' as query from sqlite_master where type = 'table' and name != 'sqlite_sequence'`;
        const dropQueries: ObjectLiteral[] = await this.query(selectDropsQuery);
        await Promise.all(dropQueries.map(q => this.query(q["query"])));
    }

    /**
     * Starts transaction.
     */
    async beginTransaction(): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();
        if (this.databaseConnection.isTransactionActive)
            throw new TransactionAlreadyStartedError();

        await this.query("BEGIN TRANSACTION");
        this.databaseConnection.isTransactionActive = true;
    }

    /**
     * Commits transaction.
     */
    async commitTransaction(): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();
        if (!this.databaseConnection.isTransactionActive)
            throw new TransactionNotStartedError();

        await this.query("COMMIT");
        this.databaseConnection.isTransactionActive = false;
    }

    /**
     * Rollbacks transaction.
     */
    async rollbackTransaction(): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();
        if (!this.databaseConnection.isTransactionActive)
            throw new TransactionNotStartedError();

        await this.query("ROLLBACK");
        this.databaseConnection.isTransactionActive = false;
    }

    /**
     * Checks if transaction is in progress.
     */
    isTransactionActive(): boolean {
        return this.databaseConnection.isTransactionActive;
    }

    /**
     * Executes a given SQL query.
     */
    query(query: string, parameters?: any[]): Promise<any> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        // console.log("query: ", query);
        // console.log("parameters: ", parameters);
        this.logger.logQuery(query);
        return new Promise<any[]>((ok, fail) => {
            this.databaseConnection.connection.all(query, parameters, (err: any, result: any) => {
                if (err) {
                    this.logger.logFailedQuery(query);
                    this.logger.logQueryError(err);
                    fail(err);
                } else {
                    ok(result);
                }
            });
        });
    }

    /**
     * Insert a new row into given table.
     */
    async insert(tableName: string, keyValues: ObjectLiteral, idColumn?: ColumnMetadata): Promise<any> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        const keys = Object.keys(keyValues);
        const columns = keys.map(key => this.driver.escapeColumnName(key)).join(", ");
        const values = keys.map((key, index) => "$" + (index + 1)).join(",");
        const sql = `INSERT INTO ${this.driver.escapeTableName(tableName)}(${columns}) VALUES (${values})`;
        const parameters = keys.map(key => keyValues[key]);

        // console.log("query: ", sql);
        // console.log("parameters: ", parameters);
        this.logger.logQuery(sql);
        return new Promise<any[]>((ok, fail) => {
            const _this = this;
            this.databaseConnection.connection.run(sql, parameters, function (err: any): void {
                if (err) {
                    _this.logger.logFailedQuery(sql);
                    _this.logger.logQueryError(err);
                    fail(err);
                } else {
                    if (idColumn)
                        return ok(this["lastID"]);

                    ok();
                }
            });
        });
    }

    /**
     * Updates rows that match given conditions in the given table.
     */
    async update(tableName: string, valuesMap: ObjectLiteral, conditions: ObjectLiteral): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        const updateValues = this.parametrize(valuesMap).join(", ");
        const conditionString = this.parametrize(conditions, Object.keys(valuesMap).length).join(" AND ");
        const query = `UPDATE ${this.driver.escapeTableName(tableName)} SET ${updateValues} ${conditionString ? (" WHERE " + conditionString) : ""}`;
        const updateParams = Object.keys(valuesMap).map(key => valuesMap[key]);
        const conditionParams = Object.keys(conditions).map(key => conditions[key]);
        const allParameters = updateParams.concat(conditionParams);
        await this.query(query, allParameters);
    }

    /**
     * Deletes from the given table by a given conditions.
     */
    async delete(tableName: string, conditions: ObjectLiteral): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        const conditionString = this.parametrize(conditions).join(" AND ");
        const parameters = Object.keys(conditions).map(key => conditions[key]);
        const query = `DELETE FROM "${tableName}" WHERE ${conditionString}`;
        await this.query(query, parameters);
    }

    /**
     * Inserts rows into closure table.
     */
    async insertIntoClosureTable(tableName: string, newEntityId: any, parentId: any, hasLevel: boolean): Promise<number> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        let sql = "";
        if (hasLevel) {
            sql = `INSERT INTO ${this.driver.escapeTableName(tableName)}(ancestor, descendant, level) ` +
                `SELECT ancestor, ${newEntityId}, level + 1 FROM ${this.driver.escapeTableName(tableName)} WHERE descendant = ${parentId} ` +
                `UNION ALL SELECT ${newEntityId}, ${newEntityId}, 1`;
        } else {
            sql = `INSERT INTO ${this.driver.escapeTableName(tableName)}(ancestor, descendant) ` +
                `SELECT ancestor, ${newEntityId} FROM ${this.driver.escapeTableName(tableName)} WHERE descendant = ${parentId} ` +
                `UNION ALL SELECT ${newEntityId}, ${newEntityId}`;
        }
        await this.query(sql);
        const results: ObjectLiteral[] = await this.query(`SELECT MAX(level) as level FROM ${tableName} WHERE descendant = ${parentId}`);
        return results && results[0] && results[0]["level"] ? parseInt(results[0]["level"]) + 1 : 1;
    }

    /**
     * Loads all tables (with given names) from the database and creates a TableSchema from them.
     */
    async loadSchemaTables(tableNames: string[], namingStrategy: NamingStrategyInterface): Promise<TableSchema[]> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        // if no tables given then no need to proceed

        if (!tableNames)
            return [];

        // load tables, columns, indices and foreign keys
        const dbTables: ObjectLiteral[] = await this.query(`SELECT * FROM sqlite_master WHERE name != 'sqlite_sequence'`);

        // if tables were not found in the db, no need to proceed
        if (!dbTables || !dbTables.length)
            return [];

        // create table schemas for loaded tables
        return Promise.all(dbTables.map(async dbTable => {
            const tableSchema = new TableSchema(dbTable["name"]);

            // load columns and indices
            const [dbColumns, dbIndices, dbForeignKeys]: ObjectLiteral[][] = await Promise.all([
                this.query(`PRAGMA table_info("${dbTable["name"]}")`),
                this.query(`PRAGMA index_list("${dbTable["name"]}")`),
                this.query(`PRAGMA foreign_key_list("${dbTable["name"]}")`),
            ]);

            // find column name with auto increment
            let autoIncrementColumnName: string|undefined = undefined;
            const tableSql: string = dbTable["sql"];
            if (tableSql.indexOf("AUTOINCREMENT") !== -1) {
                autoIncrementColumnName = tableSql.substr(0, tableSql.indexOf("AUTOINCREMENT"));
                const comma = autoIncrementColumnName.lastIndexOf(",");
                const bracket = autoIncrementColumnName.lastIndexOf("(");
                if (comma !== -1) {
                    autoIncrementColumnName = autoIncrementColumnName.substr(comma);
                    autoIncrementColumnName = autoIncrementColumnName.substr(0, autoIncrementColumnName.lastIndexOf("\""));
                    autoIncrementColumnName = autoIncrementColumnName.substr(autoIncrementColumnName.indexOf("\"") + 1);

                } else if (bracket !== -1) {
                    autoIncrementColumnName = autoIncrementColumnName.substr(bracket);
                    autoIncrementColumnName = autoIncrementColumnName.substr(0, autoIncrementColumnName.lastIndexOf("\""));
                    autoIncrementColumnName = autoIncrementColumnName.substr(autoIncrementColumnName.indexOf("\"") + 1);
                }
            }

            // create column schemas from the loaded columns
            tableSchema.columns = dbColumns.map(dbColumn => {
                const columnSchema = new ColumnSchema();
                columnSchema.name = dbColumn["name"];
                columnSchema.type = dbColumn["type"];
                columnSchema.default = dbColumn["dflt_value"] !== null && dbColumn["dflt_value"] !== undefined ? dbColumn["dflt_value"] : undefined;
                columnSchema.isNullable = dbColumn["notnull"] === 0;
                columnSchema.isPrimary = dbColumn["pk"] === 1;
                columnSchema.comment = ""; // todo
                columnSchema.isGenerated = autoIncrementColumnName === dbColumn["name"];
                const columnForeignKeys = dbForeignKeys
                    .filter(foreignKey => foreignKey["from"] === dbColumn["name"])
                    .map(foreignKey => {
                        const keyName = namingStrategy.foreignKeyName(dbTable["name"], [foreignKey["from"]], foreignKey["table"], [foreignKey["to"]]);
                        return new ForeignKeySchema(keyName, [foreignKey["from"]], [foreignKey["to"]], foreignKey["table"], foreignKey["on_delete"]); // todo: how sqlite return from and to when they are arrays? (multiple column foreign keys)
                    });
                tableSchema.addForeignKeys(columnForeignKeys);
                return columnSchema;
            });

            // create primary key schema
            const primaryKey = dbIndices.find(index => index["origin"] === "pk");
            if (primaryKey)
                tableSchema.primaryKey = new PrimaryKeySchema(primaryKey["name"]);

            // create foreign key schemas from the loaded indices
            // tableSchema.foreignKeys = dbForeignKeys.map(dbForeignKey => {
            //     const keyName = namingStrategy.foreignKeyName(dbTable["name"], [dbForeignKey["from"]], dbForeignKey["table"], [dbForeignKey["to"]]);
            //     return new ForeignKeySchema(keyName, dbForeignKey["from"], dbForeignKey["to"], dbForeignKey["table"]);
            // });

            // create unique key schemas from the loaded indices
            tableSchema.uniqueKeys = dbIndices
                .filter(dbIndex => dbIndex["unique"] === "1")
                .map(dbUniqueKey => new UniqueKeySchema(dbUniqueKey["constraint_name"]));

            // create index schemas from the loaded indices
            tableSchema.indices = dbIndices
                .filter(dbIndex => {
                    return  dbIndex["origin"] !== "pk" &&
                            (!tableSchema.foreignKeys || !tableSchema.foreignKeys.find(foreignKey => foreignKey.name === dbIndex["name"])) &&
                            (!tableSchema.primaryKey || tableSchema.primaryKey.name !== dbIndex["name"]);
                })
                .map(dbIndex => dbIndex["index_name"])
                .filter((value, index, self) => self.indexOf(value) === index) // unqiue
                .map(dbIndexName => {
                    const columnNames = dbIndices
                        .filter(dbIndex => dbIndex["table_name"] === tableSchema.name && dbIndex["index_name"] === dbIndexName)
                        .map(dbIndex => dbIndex["column_name"]);

                    return new IndexSchema(dbIndexName, columnNames);
                });

            return tableSchema;
        }));
    }

    /**
     * Creates a new table from the given table metadata and column metadatas.
     */
    async createTable(table: TableMetadata, columns: ColumnMetadata[]): Promise<ColumnMetadata[]> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        // skip columns with foreign keys, we will add them later
        const columnDefinitions = columns.map(column => this.buildCreateColumnSql(column, false)).join(", ");
        const sql = `CREATE TABLE "${table.name}" (${columnDefinitions})`;
        await this.query(sql);
        return columns;
    }

    /**
     * Creates a new column from the column metadata in the table.
     */
    async createColumns(tableSchema: TableSchema, columns: ColumnMetadata[]): Promise<ColumnMetadata[]> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        // don't create columns if it has a foreign key
        // if (column.foreignKeys.length > 0)
        //     return false;

        // const withoutForeignKeyColumns = columns.filter(column => column.foreignKeys.length === 0);
        const columnsSchemas = columns.map(column => ColumnSchema.create(this, column));
        const dbColumns = tableSchema.columns.concat(columnsSchemas);
        await this.recreateTable(tableSchema, dbColumns);
        return columns;
    }

    /**
     * Changes a column in the table.
     * Changed column looses all its keys in the db.
     */
    async changeColumns(tableSchema: TableSchema, changedColumns: { newColumn: ColumnMetadata, oldColumn: ColumnSchema }[]): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        const newDbColumns = changedColumns.map(changedColumn => ColumnSchema.create(this, changedColumn.newColumn));
        const oldColumns = tableSchema.columns.filter(dbColumn => {
            return !!changedColumns.find(changedColumn => changedColumn.oldColumn.name === dbColumn.name);
        });

        const newTable = tableSchema.clone();
        newTable.removeColumns(oldColumns);
        newTable.addColumns(newDbColumns);
        return this.recreateTable(newTable);
    }

    /**
     * Drops the columns in the table.
     */
    async dropColumns(tableSchema: TableSchema, columns: ColumnSchema[]): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        const newTable = tableSchema.clone();
        newTable.removeColumns(columns);
        return this.recreateTable(newTable);
    }

    /**
     * Creates a new foreign keys.
     */
    async createForeignKeys(tableSchema: TableSchema, foreignKeys: ForeignKeySchema[]): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        const newTable = tableSchema.clone();
        newTable.addForeignKeys(foreignKeys);
        return this.recreateTable(newTable);
    }

    /**
     * Drops a foreign keys from the table.
     */
    async dropForeignKeys(tableSchema: TableSchema, foreignKeys: ForeignKeySchema[]): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        const newTable = tableSchema.clone();
        newTable.removeForeignKeys(foreignKeys);
        return this.recreateTable(newTable);
    }

    /**
     * Creates a new index.
     */
    async createIndex(tableName: string, index: IndexMetadata): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        const sql = `CREATE ${index.isUnique ? "UNIQUE" : ""} INDEX "${index.name}" ON "${tableName}"("${index.columns.join("\", \"")}")`;
        await this.query(sql);
    }

    /**
     * Drops an index from the table.
     */
    async dropIndex(tableName: string, indexName: string, isGenerated: boolean = false): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        const sql = `DROP INDEX ${indexName}"`;
        await this.query(sql);
    }

    /**
     * Creates a new unique key.
     */
    async createUniqueKey(tableName: string, columnName: string, keyName: string): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        const sql = `CREATE UNIQUE INDEX "${keyName}" ON "${tableName}"("${columnName}")`;
        await this.query(sql);
    }

    /**
     * Creates a database type from a given column metadata.
     */
    normalizeType(column: ColumnMetadata) {
        switch (column.normalizedDataType) {
            case "string":
                return "character varying(" + (column.length ? column.length : 255) + ")";
            case "text":
                return "text";
            case "boolean":
                return "boolean";
            case "integer":
            case "int":
                return "integer";
            case "smallint":
                return "smallint";
            case "bigint":
                return "bigint";
            case "float":
                return "real";
            case "double":
            case "number":
                return "double precision";
            case "decimal":
                if (column.precision && column.scale) {
                    return `decimal(${column.precision},${column.scale})`;

                } else if (column.scale) {
                    return `decimal(${column.scale})`;

                } else if (column.precision) {
                    return `decimal(${column.precision})`;

                } else {
                    return "decimal";

                }
            case "date":
                return "date";
            case "time":
                if (column.timezone) {
                    return "time with time zone";
                } else {
                    return "time without time zone";
                }
            case "datetime":
                if (column.timezone) {
                    return "timestamp with time zone";
                } else {
                    return "timestamp without time zone";
                }
            case "json":
                return "json";
            case "simple_array":
                return column.length ? "character varying(" + column.length + ")" : "text";
        }

        throw new DataTypeNotSupportedByDriverError(column.type, "SQLite");
    }

    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------

    /**
     * Database name shortcut.
     */
    protected get dbName(): string {
        return this.driver.options.database as string;
    }

    /**
     * Parametrizes given object of values. Used to create column=value queries.
     */
    protected parametrize(objectLiteral: ObjectLiteral, startIndex: number = 0): string[] {
        return Object.keys(objectLiteral).map((key, index) => this.driver.escapeColumnName(key) + "=$" + (startIndex + index + 1));
    }

    /**
     * Builds a query for create column.
     */
    protected buildCreateColumnSql(column: ColumnSchema, skipPrimary: boolean, createForeignKeys?: boolean): string;
    protected buildCreateColumnSql(column: ColumnMetadata, skipPrimary: boolean, createForeignKeys?: boolean): string;
    protected buildCreateColumnSql(column: ColumnMetadata|ColumnSchema, skipPrimary: boolean, createForeignKeys: boolean = false): string {
        let c = "\"" + column.name + "\"";
        if (column instanceof ColumnMetadata) {
            c += " " + this.normalizeType(column);
        } else {
            c += " " + column.type;
        }
        if (column.isNullable !== true)
            c += " NOT NULL";
        if (column.isPrimary === true && !skipPrimary) // todo: don't use primary keys this way at all
            c += " PRIMARY KEY";
        if (column.isGenerated === true) // don't use skipPrimary here since updates can update already exist primary without auto inc.
            c += " AUTOINCREMENT";
        // if (column instanceof ColumnMetadata && column.foreignKeys.length > 0 && createForeignKeys)
        //     c += ` REFERENCES "${column.foreignKeys[0].referencedTable.name}"("${column.foreignKeys[0].referencedColumnNames.join("\", \"")}")`; // todo: add multiple foreign keys support
        // if (column instanceof ColumnSchema && column.foreignKeys.length > 0 && createForeignKeys)
        //     c += ` REFERENCES "${column.foreignKeys[0].toTable}"("${column.foreignKeys[0].to}")`; // todo: add multiple foreign keys support

        return c;
    }

    protected async recreateTable(tableSchema: TableSchema,
                                  options?: { createForeignKeys?: boolean }): Promise<void> {
        // const withoutForeignKeyColumns = columns.filter(column => column.foreignKeys.length === 0);
        // const createForeignKeys = options && options.createForeignKeys;
        const columnDefinitions = tableSchema.columns.map(dbColumn => this.buildCreateColumnSql(dbColumn, false)).join(", ");
        const columnNames = tableSchema.columns.map(column => `"${column.name}"`).join(", ");

        let sql1 = `CREATE TABLE "temporary_${tableSchema.name}" (${columnDefinitions}`;
        // if (options && options.createForeignKeys) {
        tableSchema.foreignKeys.forEach(foreignKey => {
            const columnNames = foreignKey.columnNames.map(name => `"${name}"`).join(", ");
            const referencedColumnNames = foreignKey.referencedColumnNames.map(name => `"${name}"`).join(", ");
            sql1 += `, FOREIGN KEY(${columnNames}) REFERENCES "${foreignKey.referencedTableName}"(${referencedColumnNames})`;
        });
        if (tableSchema.primaryKey) {
            sql1 += `, PRIMARY KEY(${tableSchema.primaryKey.name})`;
        }
        sql1 += ")";

        // todo: need also create uniques and indices?

        // if (options && options.createIndices)
        await this.query(sql1);

        const sql2 = `INSERT INTO "temporary_${tableSchema.name}" SELECT ${columnNames} FROM "${tableSchema.name}"`;
        await this.query(sql2);

        const sql3 = `DROP TABLE "${tableSchema.name}"`;
        await this.query(sql3);

        const sql4 = `ALTER TABLE "temporary_${tableSchema.name}" RENAME TO "${tableSchema.name}"`;
        await this.query(sql4);
    }

}