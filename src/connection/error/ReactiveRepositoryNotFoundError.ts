/**
 * @internal
 */
export class ReactiveRepositoryNotFoundError extends Error {
    name = "ReactiveRepositoryNotFoundError";

    constructor(connectionName: string, entityClass: Function|string) {
        super();
        const targetName = typeof entityClass === "function" && (<any> entityClass).name ? (<any> entityClass).name : entityClass;
        this.message = `No reactive repository for "${targetName}" was found. Looks like this entity is not registered in ` + 
            `current "${connectionName}" connection?`;
    }

}