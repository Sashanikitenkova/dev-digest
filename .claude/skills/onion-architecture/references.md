# References

External sources gathered while researching this skill, organized by topic. Every source found during research is kept here — this list is not trimmed.

## 1. Origin & core definition

- **The Onion Architecture: Part 1** — Jeffrey Palermo (2008-07-29). https://jeffreypalermo.com/2008/07/the-onion-architecture-part-1/ — coins the term; the core rule ("all code can depend on layers more central, but code cannot depend on layers further out") and why infrastructure (which changes fastest) belongs at the edge.
- **The Onion Architecture: Part 2** — Jeffrey Palermo. https://jeffreypalermo.com/2008/07/the-onion-architecture-part-2/
- **The Onion Architecture: Part 3** — Jeffrey Palermo. https://jeffreypalermo.com/2008/08/the-onion-architecture-part-3/
- **Onion Architecture: Part 4 – After Four Years** — Jeffrey Palermo (2013). https://jeffreypalermo.com/2013/08/onion-architecture-part-4-after-four-years/ — retrospective and clarifications.
- **Onion Architecture tag index** — Jeffrey Palermo. https://jeffreypalermo.com/tag/onion-architecture/
- **Onion Architecture** — Herberto Graça (2017-09-21), "The Software Architecture Chronicles." https://herbertograca.com/2017/09/21/onion-architecture/ (mirrored: https://medium.com/the-software-architecture-chronicles/onion-architecture-79529d127f85) — positions Onion as an evolution of Ports & Adapters with DDD-informed internal layers (Domain Model → Domain Services → Application Services → outer Infra/UI); notes outer layers may call any inner layer directly, not just the one immediately below.

## 2. Onion vs Hexagonal vs Clean vs N-Tier

- **Hexagonal Architecture (original)** — Alistair Cockburn (2005-09-04). https://alistair.cockburn.us/hexagonal-architecture/ — introduces Ports & Adapters: a port is a purposeful conversation/boundary, multiple adapters can plug into one port. Predates Onion by 3 years. Also: https://jmgarridopaz.github.io/content/interviewalistair.html and https://jmgarridopaz.github.io/content/resources.html
- **Hexagonal architecture (software)** — Wikipedia. https://en.wikipedia.org/wiki/Hexagonal_architecture_(software)
- **The Clean Architecture** — Robert C. Martin ("Uncle Bob") (2012-08-13). https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html — the canonical Dependency Rule circle diagram: source-code dependencies can only point inward.
- **Clean Architecture: Standing on the shoulders of giants** — Herberto Graça (2017-09-28). https://herbertograca.com/2017/09/28/clean-architecture-standing-on-the-shoulders-of-giants/ — traces the lineage Hexagonal → Onion → Clean → DCI/BCE as convergent evolutions of the same idea.
- **Onion vs Clean vs Hexagonal Architecture** — Eric Damtoft. https://medium.com/@edamtoft/onion-vs-clean-vs-hexagonal-architecture-9ad94a27da91 — frames Hexagonal as the bare-bones application of the shared idea ("hexagon" is just a drawing convention); all three externalize infra/UI to the edges and are DIP-based. (Note: full text was paywalled during research — cite but don't over-rely on it.)
- **N-Tier vs Hexagonal vs Onion vs Clean Architecture in VERY simple terms** — Dorin Baba. https://medium.com/@dorinbaba/n-tier-vs-hexagonal-vs-onion-vs-clean-architecture-in-very-simple-terms-68f66c4dba22
- **Layered Software Architecture Styles: Clean/Onion vs. Layered/N-Tier** — Newnop. https://www.newnop.com/blog/layered-software-architecture-styles-clean-onion-vs-layered-n-tier
- **Common web application architectures** — Microsoft Learn / .NET Architecture Guidance (ardalis). https://learn.microsoft.com/en-us/dotnet/architecture/modern-web-apps-azure/common-web-application-architectures — the strongest authority found: states Hexagonal/Ports-and-Adapters/Onion/Clean Architecture are the same underlying pattern under different names. Details traditional N-Tier's problem (business logic depends on data-access implementation details, hurting testability) versus the inverted model. Reference implementations: https://github.com/dotnet-architecture/eShopOnWeb and https://github.com/ardalis/cleanarchitecture

## 3. Core rules and principles

- **Anti-Corruption Layer Pattern** — Azure Architecture Center, Microsoft Learn. https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer — an ACL is a deliberate translation boundary (Adapter + Translator + Facade) preventing an external system's model from leaking into your domain.
- **Anti-Corruption Layer** — DevIQ (Ardalis). https://deviq.com/domain-driven-design/anti-corruption-layer/
- **Anticorruption Layer** — Domain-Driven Design: A Practitioner's Guide. https://ddd-practitioners.com/home/glossary/bounded-context/bounded-context-relationship/anticorruption-layer/
- **Anti-corruption layer pattern** — AWS Prescriptive Guidance. https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/acl.html
- **Unit Testing Use Cases or Domain?** — Valentina Jemuović. https://journal.optivem.com/p/unit-testing-use-cases-or-domain
- **Testable architecture** — Cucumber docs. https://cucumber.io/docs/guides/testable-architecture/
- **Onion Architecture in DDD - Keeping Your Domain Pure and Testable in .NET** — ilovedotnet.org. https://ilovedotnet.org/blogs/ddd-onion-architecture-in-dotnet/

## 4. Node.js / TypeScript practical implementation guides

### General Node/TS onion

- **Implementing SOLID and the onion architecture in Node.js with TypeScript and InversifyJS** — Remo H. Jansen (InversifyJS author). https://dev.to/remojansen/implementing-the-onion-architecture-in-nodejs-with-typescript-and-inversifyjs-10ad — concrete layering: Domain (models + repository interfaces) → Domain Services → Application Services → Infrastructure; interfaces in domain, implementations in infrastructure, bound at runtime via InversifyJS.
- **Enforce Clean Architecture in Your TypeScript Projects with fresh-onion** — Remo H. Jansen. https://dev.to/remojansen/enforce-clean-architecture-in-your-typescript-projects-with-fresh-onion-45pi — a lint-like tool enforcing the dependency rule between TS project layers.
- **Onion Architecture in Node.js with Typescript** — Sankhadip Samanta. https://sankhadip.medium.com/onion-architecture-in-node-js-with-typescript-5508612a4391 — simple folder structure (`DA`, `routes`, `service`, `types`), manual constructor DI.
- **Onion Architecture: An Example Folder Structure — Nest.js** — Debasis Das. https://medium.com/@debasisdasnospdii/onion-architecture-an-example-folder-structure-nest-js-480ea9c6ec3a
- **Understanding Onion Architecture: An Example Folder Structure** — Alessandro Traversi. https://medium.com/@alessandro.traversi/understanding-onion-architecture-an-example-folder-structure-9c62208cc97d — fuller 4-ring layout: `domain/{entities,repositories,services}`, `application/{usecases,dtos,mappers}`, `infrastructure/{persistence,services,external}`, `presentation/{controllers,views,routes}`.
- **Clean architecture with TypeScript: DDD, Onion** — André Bazaglia. https://bazaglia.com/clean-architecture-with-typescript-ddd-onion/
- GitHub boilerplates: `Melzar/onion-architecture-boilerplate` — https://github.com/Melzar/onion-architecture-boilerplate · `JeffMangan/typescript-onion` — https://github.com/JeffMangan/typescript-onion · `mike-yuen/house-express` — https://github.com/mike-yuen/house-express
- **onion-architecture GitHub topic (TypeScript filter)** — https://github.com/topics/onion-architecture?l=typescript

### Fastify

- **Fastify Encapsulation (official docs)** — https://fastify.dev/docs/latest/Reference/Encapsulation/ — `register()` creates a new encapsulation context; decorators/hooks in a child context don't leak to siblings/ancestors (a DAG), the mechanism for scoping domain services to the routes that need them.
- **Fastify Plugins Guide (official docs)** — https://fastify.dev/docs/latest/Guides/Plugins-Guide/
- **Fastify Decorators Reference (official docs)** — https://fastify.dev/docs/latest/Reference/Decorators/ — `decorate`/`decorateRequest`/`decorateReply`, the primitives for injecting services into handlers without hardwired imports.
- **The complete guide to the Fastify plugin system** — Nearform. https://nearform.com/digital-community/the-complete-guide-to-fastify-plugin-system/ — `register`/decorators as a lightweight DI system.
- **@fastify/awilix** — https://github.com/fastify/fastify-awilix and **awilix** (jeffijoe) — https://github.com/jeffijoe/awilix — the most commonly recommended route to real constructor-injection-style DI in Fastify.
- **fastify-decorators** (L2jLiga) — https://github.com/L2jLiga/fastify-decorators/blob/v3/docs/Services%20and%20dependency%20injection.md — TS-decorator-based Controllers/Services/`@Inject` layered on Fastify's native decorators.
- **GitHub Discussion #3698 — "Passing dependencies to route handlers, & performance implications"** — https://github.com/fastify/fastify/discussions/3698
- **fastify-clean-architecture** (revell29) — https://github.com/revell29/fastify-clean-architecture — Fastify+TS DDD/Clean Architecture template: Domain (entities, aggregates, value objects, repository interfaces), Application (use cases), Infrastructure (DB, repository implementations, Fastify wiring), Interfaces (controllers/routes/serializers).
- **clean-architecture-fastify-mongodb** (borjatur) — https://github.com/borjatur/clean-architecture-fastify-mongodb

### Drizzle

- **Repository Pattern in Nest.js with Drizzle ORM** — vimulatus. https://medium.com/@vimulatus/repository-pattern-in-nest-js-with-drizzle-orm-e848aa75ecae — repository classes wrap Drizzle queries as sole schema consumers; notably pragmatic (composition-based, not full interface inversion) — a friction point worth naming. Also covers transaction propagation via `AsyncLocalStorage`.
- **Drizzle ORM Best Practices: Principles, Patterns, and Real-World Case Studies** — Paul Serban. https://www.paulserban.eu/blog/post/drizzle-orm-best-practices-principles-patterns-and-real-world-case-studies/ — domain types separate from DB schema; repositories return domain types, never `InferSelectModel` results directly to services.
- **Repository Pattern (Cosmic Python)** — Harry Percival & Bob Gregory. https://www.cosmicpython.com/book/chapter_02_repository — the canonical port/adapter framing ("the port is the interface, the adapter is the implementation"); repositories exist to be faked in unit tests.
- **5 Reasons to Choose Drizzle ORM Over Traditional JavaScript ORMs** — SoftwareMill. https://softwaremill.com/5-reasons-to-choose-drizzle-orm-over-traditional-javascript-orms/ — Drizzle mirrors SQL directly with no codegen step, meaning isolating the domain from Drizzle requires an explicit mapping step, unlike codegen-based ORMs like Prisma.
- **TypeORM/MySQL to Drizzle/PostgreSQL — How Repository Pattern...** — Muyiwa Olayinka, LinkedIn. https://www.linkedin.com/pulse/typeormmysql-drizzlepostgresql-how-repository-pattern-muyiwa-olayinka-s5kce — first-hand account: a pre-existing repository abstraction made an ORM swap low-risk.
- **Drizzle GitHub Issue #2576 — "[FEATURE]: Use a schema language abstraction"** — https://github.com/drizzle-team/drizzle-orm/issues/2576 — primary-source evidence of Drizzle's schema-as-TypeScript coupling friction.
- **Hexagonal Architecture in NestJS: "Stop Mocking Prisma and Start Designing for Change"** — Sandy Zhang. https://medium.com/@srachel27/hexagonal-architecture-in-nestjs-stop-mocking-prisma-and-start-designing-for-change-6d1bab989622 — same principle with Prisma; ports as TS interfaces + Symbol injection tokens + adapter classes.

### TypeScript patterns (DI, ports, value objects, Zod)

- **Dependency Injection in Node.js & TypeScript: The Part Nobody Teaches You** — thetshaped.dev. https://thetshaped.dev/p/dependency-injection-in-nodejs-and-typescript-dependency-inversion-part-no-body-teaches-you — DI as "just passing arguments"; manual constructor injection + composition root covers ~90% of Node apps without a DI framework.
- **tsyringe** (Microsoft). https://github.com/microsoft/tsyringe — lightweight decorator-based DI container, an alternative to InversifyJS.
- **Parse, don't validate** — Alexis King (2019). https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/ — the canonical article: validators discard information, parsers transform input into more-structured output and carry proof of validity in the type. Maps directly to using Zod's `.parse()` to produce a typed domain value at the boundary.
- **Parse, Don't Validate — In a Language That Doesn't Want You To** — cekrem.github.io. https://cekrem.github.io/posts/parse-dont-validate-typescript/ — TypeScript-specific follow-up.
- **Zod — Defining schemas (official docs)** — https://zod.dev/api — `.parse()`/`.safeParse()`/`z.infer<>`; a Zod schema validates/parses the wire format, it is not itself the domain entity.
- **Value Objects — DDD w/ TypeScript** — Khalil Stemmler. https://khalilstemmler.com/articles/typescript-value-object/ — private constructors + static factories, structural equality, immutability via `Object.freeze`, validation co-located to avoid anemic domain models.
- **Branded Types in TypeScript** — Sergio Carracedo. https://sergiocarracedo.es/branded-types/
- **Usecases for TypeScript Brand Types** — egghead.io. https://egghead.io/usecases-for-type-script-brand-types~nzix2

### LLM-pipeline-specific (ports & adapters for LLM calls)

- **Hexagonal Architecture for GenAI Chatbots: Decoupling AI Logic from the Rest** — Shiva Ram. https://shivaramp.medium.com/hexagonal-architecture-for-genai-chatbots-decoupling-ai-logic-from-the-rest-fef1a162330c — defines a Core with an output Port like `generateResponse(prompt)` naming no vendor, and vendor-specific Adapters (OpenAI, Anthropic) implementing it. "To move from OpenAI to Anthropic, you implement a new adapter and swap it in."
- **Hexagonal Architecture for Backend Development in the Age of AI** — Ziv Kochavi Doron. https://medium.com/@cashhatcorp/hexagonal-architecture-for-backend-development-in-the-age-of-ai-4a74a1568e6a — the `IntelligencePort` framing.
- **Applying Hexagonal Architecture in AI Agent Development** — Marta Fernández García. https://medium.com/@martia_es/applying-hexagonal-architecture-in-ai-agent-development-44199f6136d3 — worked example for pipeline-shaped (not just chat-shaped) LLM usage.
- **Model Swaps Without Drama: Adapters, Not Rewrites** — Modexa. https://medium.com/@Modexa/model-swaps-without-drama-adapters-not-rewrites-b9c739205cd7 — "Define your own neutral interface. Hide provider weirdness behind it… The vendor SDKs live strictly behind that wall."
- **llm_api_adapter** (Inozem). https://github.com/Inozem/llm_api_adapter — a real pluggable-adapter implementation unifying OpenAI/Anthropic/Google behind one interface.
- **Hexagonal architecture & AI Workshop** — Ableneo. https://www.ableneo.com/insight/hexagonal-architecture-for-ai-integration/

### Testing implications

- **Hexagonal architecture in practice: Testing** — tsukiyo.io. https://tsukiyo.io/posts/hexagonal-architecture-in-practice-testing/ — every external dependency hidden behind a port; tests swap the production adapter for an in-memory/recording fake; layered trust model between use-case tests and adapter tests.
- **Understanding the Test Pyramid in Hexagonal Architecture** — Educative. https://www.educative.io/courses/hexagonal-architecture-web-apps/the-test-pyramid
- **End-to-End Testing in Hexagonal Architecture: The Complete Testing Strategy** — Ayoub El Maalmi. https://medium.com/@ayoubelmaalmi/end-to-end-testing-in-hexagonal-architecture-the-complete-testing-strategy-e40bf704f359
- **Writing Tests With Fastify and Node Test Runner** — Nearform, Richie McColl. https://nearform.com/insights/writing-tests-with-fastify-and-node-test-runner/ (cross-posted: https://richiemccoll.com/writing-tests-with-fastify-and-node-test-runner/) — distinguishes `fastify.inject()` (fast, no socket) from a real listening server + `fetch` (true integration test).
- **Fastify Testing Guide (official docs)** — https://github.com/fastify/fastify/blob/main/docs/Guides/Testing.md
- **Testing Fastify Apps Like a Boss** — James Gardner. https://www.james-gardner.dev/posts/testing-fastify-apps/ — app-factory pattern, mocking decorated services.
- **How to Unit Test Fastify Routes and Plugins: A Practical Guide** — AST Consulting. https://astconsulting.in/java-script/nodejs/fastify/how-to-unit-test-fastify-routes-plugins-guide

## 5. Common pitfalls / anti-patterns

- **Onion Architecture: An Opinionated Approach Part 2, Anemic Data Models** — IExtendable. http://iextendable.com/2013/04/16/onion-architecture-an-opinionated-approach-part-2-anemic-data-models/
- **The DTO dilemma** — Professional Beginner. https://professionalbeginner.com/the-dto-dilemma/ — DTOs are pure data with no behavior; mappers translate DTO ↔ Domain object at boundaries; warns against reusing one DTO across multiple use cases and against excessive DTO → Domain → Persistence → Network mapping chains.
- **Onion Architecture explained — Building maintainable software** — Marco Schaefer. https://marcoatschaefer.medium.com/onion-architecture-explained-building-maintainable-software-54996ff8e464
- **12 Common Mistakes in Implementing Clean Architecture** — ezzylearning.net. https://www.ezzylearning.net/tutorial/twelve-common-mistakes-in-implementing-clean-architecture
- **Is Clean Architecture Overengineering?** — Three Dots Labs. https://threedots.tech/episode/is-clean-architecture-overengineering/ — a deliberately-included balanced/cautionary voice: warns against applying it to small/simple apps, recommends starting simple and evolving.
- **Why Your "Clean Architecture" Is Making Things More Complicated** — AlgoCademy. https://algocademy.com/blog/why-your-clean-architecture-is-making-things-more-complicated/
- **Benefits and Drawbacks of Adopting Clean Architecture** — DEV Community, yukionishi1129. https://dev.to/yukionishi1129/benefits-and-drawbacks-of-adopting-clean-architecture-2pd1
