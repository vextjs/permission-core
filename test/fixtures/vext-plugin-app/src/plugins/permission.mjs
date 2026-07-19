import { permissionPlugin } from "permission-core/plugins/vext";

export default permissionPlugin({
    databasePlugin: "database",
    authPlugin: "authentication",
    core: {
        collectionPrefix: "pc_vext_api",
    },
});
