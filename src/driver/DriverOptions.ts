/**
 * Driver options contains connectivity options used to connection to the database.
 */
export interface DriverOptions {

    /**
     * Database type.
     */
    readonly type: "mysql"|"postgres"|"mariadb"|"sqlite"|"oracle"|"mssql";

    /**
     * Connection url to where perform connection to.
     */
    readonly url?: string;

    /**
     * Database host.
     */
    readonly host?: string;

    /**
     * Database host port.
     */
    readonly port?: number;

    /**
     * Database username.
     */
    readonly username?: string;

    /**
     * Database password.
     */
    readonly password?: string;

    /**
     * Database name to connect to.
     */
    readonly database?: string;

    /**
     * Connection SID (used for Oracle databases).
     */
    readonly sid?: string;

    /**
     * Storage type or path to the storage (used for SQLite databases).
     */
    readonly storage?: string;

    /**
     * Indicates if connection pooling should be used or not.
     * Be default it is enabled if its supported by a platform. Set to false to disable it.
     */
    readonly usePool?: boolean;

    /**
     * Extra connection options to be passed to the driver.
     */
    readonly extra?: any;

}
