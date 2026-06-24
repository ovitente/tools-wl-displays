export namespace main {
	
	export class Mode {
	    w: number;
	    h: number;
	    rates: number[];
	
	    static createFrom(source: any = {}) {
	        return new Mode(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.w = source["w"];
	        this.h = source["h"];
	        this.rates = source["rates"];
	    }
	}
	export class Monitor {
	    name: string;
	    make: string;
	    model: string;
	    w: number;
	    h: number;
	    rate: number;
	    scale: number;
	    x: number;
	    y: number;
	    active: boolean;
	    primary: boolean;
	    modes: Mode[];
	
	    static createFrom(source: any = {}) {
	        return new Monitor(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.make = source["make"];
	        this.model = source["model"];
	        this.w = source["w"];
	        this.h = source["h"];
	        this.rate = source["rate"];
	        this.scale = source["scale"];
	        this.x = source["x"];
	        this.y = source["y"];
	        this.active = source["active"];
	        this.primary = source["primary"];
	        this.modes = this.convertValues(source["modes"], Mode);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

