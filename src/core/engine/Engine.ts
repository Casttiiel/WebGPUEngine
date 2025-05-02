
import { ModuleManager } from "../../modules/core/ModuleManager";
import { ModuleBoot } from "../../modules/game/ModuleBoot";
import { ModuleCameraMixer } from "../../modules/game/ModuleCameraMixer";
import { ModuleEntities } from "../../modules/game/ModuleEntities";
import { ModuleInput } from "../../modules/game/ModuleInput";
import { ModuleRender } from "../../modules/game/ModuleRender";
import { Render } from "../../renderer/core/render";
import { Time } from "./Time";

export class Engine {
    private static initialized: boolean = false;
    private static _time: Time;

    private static _modules: ModuleManager;
    private static _render: ModuleRender;
    private static _entities: ModuleEntities;
    private static _camera_mixer: ModuleCameraMixer;
    private static _input: ModuleInput;

    public static async start(): Promise<void> {
        if (this.initialized) {
            console.warn('Engine is already started.');
            return;
        }
        this.initialized = true;
        console.log('Engine started.');
        this._time = new Time();
        const canvas = document.getElementById('gfx-canvas') as HTMLCanvasElement;
        await Render.getInstance().initialize(canvas);
        
        this._modules = new ModuleManager();
        this._render = new ModuleRender("render");
        this._entities = new ModuleEntities("entities");
        this._camera_mixer = new ModuleCameraMixer("camera_mixer");
        this._input = new ModuleInput("input");

        this._modules.registerSystemModule(this._render);
        this._modules.registerSystemModule(this._entities);
        this._modules.registerSystemModule(this._camera_mixer);
        this._modules.registerSystemModule(this._input);
        this._modules.registerSystemModule(new ModuleBoot("boot"));

        await this._modules.start();
    }

    public static update(): void {
        if (!this.initialized) {
            console.error('Engine is not started yet.');
            return;
        }
        this._time.update();
        const dt = this._time.getDeltaTime();
        this._modules.update(dt);
        this._modules.renderInMenu();
    }

    public static render(): void {
        if (!this.initialized) {
            console.error('Engine is not started yet.');
            return;
        }
        this._render.generateFrame();
    }

    public static getModules(): ModuleManager {
        return this._modules;
    }

    public static getEntities(): ModuleEntities {
        return this._entities;
    }

    public static getInput(): ModuleInput {
        return this._input;
    }
}