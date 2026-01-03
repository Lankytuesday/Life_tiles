/**
 * Console test for project order when dragging to a new dashboard
 *
 * Usage: Copy and paste this entire script into the browser console
 * while on the Lifetiles dashboard page, then run:
 *   testProjectOrder()
 */

async function testProjectOrder() {
    console.log('🧪 Testing Project Order on Drag-to-Dashboard...\n');

    // Open IndexedDB
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('lifetiles', 5);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    // Get all dashboards
    const dashboards = await new Promise(resolve => {
        const tx = db.transaction(['dashboards'], 'readonly');
        const store = tx.objectStore('dashboards');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
    });

    console.log(`📊 Found ${dashboards.length} dashboards:\n`);

    // Get projects for each dashboard and show their order
    for (const dashboard of dashboards) {
        const projects = await new Promise(resolve => {
            const tx = db.transaction(['projects'], 'readonly');
            const store = tx.objectStore('projects');
            const index = store.index('dashboardId');
            // Try both string and number versions of the ID
            const req = index.getAll(dashboard.id);
            req.onsuccess = () => resolve(req.result || []);
        });

        // Sort by order
        projects.sort((a, b) => {
            const ao = Number.isFinite(+a.order) ? +a.order : Number.MAX_SAFE_INTEGER;
            const bo = Number.isFinite(+b.order) ? +b.order : Number.MAX_SAFE_INTEGER;
            return ao - bo;
        });

        console.log(`📁 Dashboard: "${dashboard.name}" (ID: ${dashboard.id})`);
        console.log(`   Projects (${projects.length}):`);

        if (projects.length === 0) {
            console.log('   (no projects)');
        } else {
            projects.forEach((p, i) => {
                const orderDisplay = p.order !== undefined ? p.order : 'undefined';
                console.log(`   ${i + 1}. "${p.name}" (order: ${orderDisplay}, id: ${p.id})`);
            });

            // Calculate what the next order should be
            let maxOrder = -1;
            projects.forEach(p => {
                const order = Number.isFinite(+p.order) ? +p.order : -1;
                if (order > maxOrder) maxOrder = order;
            });
            console.log(`   → Next project would get order: ${maxOrder + 1}`);
        }
        console.log('');
    }

    // Test verification
    console.log('✅ Test complete!\n');
    console.log('To verify drag-to-dashboard order:');
    console.log('1. Drag a project to a different dashboard');
    console.log('2. Run testProjectOrder() again');
    console.log('3. Check that the moved project has the highest order in its new dashboard');

    db.close();
}

// Also provide a function to check a specific project
async function checkProject(projectName) {
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('lifetiles', 5);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    const projects = await new Promise(resolve => {
        const tx = db.transaction(['projects'], 'readonly');
        const store = tx.objectStore('projects');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
    });

    const matches = projects.filter(p =>
        p.name.toLowerCase().includes(projectName.toLowerCase())
    );

    if (matches.length === 0) {
        console.log(`❌ No project found matching "${projectName}"`);
    } else {
        matches.forEach(p => {
            console.log(`📋 Project: "${p.name}"`);
            console.log(`   ID: ${p.id}`);
            console.log(`   Dashboard ID: ${p.dashboardId} (type: ${typeof p.dashboardId})`);
            console.log(`   Order: ${p.order !== undefined ? p.order : 'undefined'}`);
        });
    }

    db.close();
}

console.log('✅ Test functions loaded!');
console.log('Run: testProjectOrder() - to see all dashboards and project orders');
console.log('Run: checkProject("name") - to find a specific project');
