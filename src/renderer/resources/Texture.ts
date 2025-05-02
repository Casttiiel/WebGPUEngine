import { ResourceManager } from "../../core/engine/ResourceManager";

export class Texture {
    private name: string;

    constructor(name: string) {
        this.name = name;
    }

    public static async get(texturePath: string): Promise<Texture> {
        if (ResourceManager.hasResource(texturePath)) {
            return ResourceManager.getResource<Texture>(texturePath);
        }

        const texture = new Texture(texturePath);
        await texture.load();
        ResourceManager.setResource(texturePath, texture);
        return texture;
    }

    public async load(): Promise<void> {

    }
}