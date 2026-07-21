import type {
    MenuConfigInput,
    MenuConfigSnapshot,
} from "../types";

function responseInputFromSnapshot(response: NonNullable<MenuConfigSnapshot["menus"][number]["views"][number]["load"][number]["response"]>) {
    return {
        ...(response.target === undefined ? {} : { target: response.target }),
        ...(response.preserve === undefined ? {} : { preserve: response.preserve }),
        fields: response.fields.map(({ fieldId: _fieldId, ...field }) => field),
    };
}

export function configInputFromSnapshot(snapshot: MenuConfigSnapshot): MenuConfigInput {
    const menuInput = (menu: MenuConfigSnapshot["menus"][number]): MenuConfigInput["menus"][number] => ({
        id: menu.id,
        title: menu.title,
        ...(menu.children.length === 0 ? {} : { children: menu.children.map(menuInput) }),
        ...(menu.views.length === 0 ? {} : { views: menu.views.map((view) => ({
            id: view.id,
            type: view.type,
            title: view.title,
            ...(view.path === undefined ? {} : { path: view.path }),
            ...(view.component === undefined ? {} : { component: view.component }),
            ...(view.url === undefined ? {} : { url: view.url }),
            navigation: view.navigation,
            enabled: view.enabled,
            ...(view.i18nKey === undefined ? {} : { i18nKey: view.i18nKey }),
            ...(view.load.length === 0 ? {} : { load: view.load.map((load) => ({
                resource: load.resource,
                ...(load.response === undefined ? {} : { response: responseInputFromSnapshot(load.response) }),
                ...(load.meta === undefined ? {} : { meta: load.meta }),
            })) }),
            ...(view.actions.length === 0 ? {} : { actions: view.actions.map((action) => ({
                ...(action.id === undefined ? {} : { id: action.id }),
                title: action.title,
                resource: action.resource,
                ...(action.opens === undefined ? {} : { opens: action.opens }),
                ...(action.response === undefined ? {} : { response: responseInputFromSnapshot(action.response) }),
                enabled: action.enabled,
                ...(action.i18nKey === undefined ? {} : { i18nKey: action.i18nKey }),
                ...(action.meta === undefined ? {} : { meta: action.meta }),
            })) }),
            ...(view.meta === undefined ? {} : { meta: view.meta }),
        })) }),
        navigation: menu.navigation,
        enabled: menu.enabled,
        ...(menu.icon === undefined ? {} : { icon: menu.icon }),
        ...(menu.i18nKey === undefined ? {} : { i18nKey: menu.i18nKey }),
        ...(menu.meta === undefined ? {} : { meta: menu.meta }),
    });
    return {
        configId: snapshot.configId,
        ...(snapshot.title === undefined ? {} : { title: snapshot.title }),
        menus: snapshot.menus.map(menuInput),
        ...(snapshot.meta === undefined ? {} : { meta: snapshot.meta }),
    };
}
