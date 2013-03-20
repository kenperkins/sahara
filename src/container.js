var DependencyGraph = require('dep-graph'),
	lifetimes = require('./lifetime');

function Registration(name, lifetime) {
	this.name = name;
	this.lifetime = lifetime || new lifetimes.Transient();
}

function TypeRegistration(name, lifetime, typeInfo) {
	Registration.call(this, name, lifetime);
	this.typeInfo = typeInfo;
}

function InstanceRegistration(name, lifetime, instance) {
	Registration.call(this, name, lifetime);
	this.instance = instance;
}

function Container() {
	this.registrations = {};
	this.graph = new DependencyGraph();
}

Container.prototype = {
	registerType: function(ctor, name, lifetime) {
		var data = /^function(?:[\s+](\w+))?\s*\((.*?)\)\s*\{/.exec(ctor.toString());
		if (!data) {
			throw new Error('Unable to parse function definition: ' + ctor.toString());
		}

		var typeName = data[1] || name,
			signature = data[2].trim();
		if (!typeName) {
			throw new Error('"name" must be given if a named function is not');
		}

		var typeInfo = {
			args: [],
			ctor: ctor
		};

		if (signature) {
			signature.split(',').forEach(function(param, i) {
				//ferret out the type of each argument based on inline jsdoc:
				//https://code.google.com/p/jsdoc-toolkit/wiki/InlineDocs
				var data = /^\/\*\*\s*(\w+)\s*\*\/\s*(\w+)\s*$/.exec(param.trim());
				if (!data) {
					throw new Error(
						'Unable to determine type of parameter at position ' + (i + 1) +
							' for type "' + typeName + '"'
					);
				}

				typeInfo.args.push({
					position: i,
					type: data[1],
					name: data[2]
				});
			});
		}

		this.registrations[typeName] = new TypeRegistration(typeName, lifetime, typeInfo);

		//add to the dependency graph to verify that there are no
		//circular dependencies (the graph isn't used anywhere else)
		for (var i = 0; i < typeInfo.args.length; i++) {
			this.graph.add(typeName, typeInfo.args[i].type);
		}
		//the graph isn't actually built until you try to get the chain
		this.graph.getChain(typeName);

		return this;
	},

	registerInstance: function(typeName, instance, lifetime) {
		if (instance === undefined) {
			throw new TypeError('No instance given');
		}

		this.registrations[typeName] = new InstanceRegistration(typeName, lifetime, instance);
		return this;
	},

	resolve: function(typeName) {
		var registration = this.registrations[typeName], instance;
		if (!registration) {
			throw new Error('The type "' + typeName + '" is not registered in the container');
		}

		var existing = registration.lifetime.fetch();
		if (existing) {
			return existing;
		}

		if (registration instanceof InstanceRegistration) {
			registration.lifetime.store(registration.instance);
			return registration.instance;
		}

		//resolve dependencies
		var params = registration.typeInfo.args,
			ctor = registration.typeInfo.ctor;

		params.sort(function(a, b) {
			if (a.position === b.position) {
				return 0;
			}

			return a.position < b.position ? -1 : 1;
		});

		var args = params.map(function(typeData) {
			return this.resolve(typeData.type);
		}.bind(this));

		//dynamically invoke the constructor
		instance = Object.create(ctor.prototype);
		ctor.apply(instance, args);
		registration.lifetime.store(instance);
		return instance;
	}
};

module.exports = Container;