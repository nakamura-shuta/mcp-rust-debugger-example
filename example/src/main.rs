fn main() {
    println!("Rust Debugging Sample Program");

    let x = 10;
    let y = 20;
    let sum = add(x, y);
    println!("Sum: {}", sum);

    let numbers = vec![1, 2, 3, 4, 5];
    let total = calculate_total(&numbers);
    println!("Total: {}", total);

    let result = process_data(100);
    println!("Result: {}", result);
}

fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn calculate_total(numbers: &[i32]) -> i32 {
    let mut sum = 0;
    for &n in numbers {
        sum += n;
    }
    sum
}

fn process_data(value: i32) -> i32 {
    let multiplied = value * 2;
    let result = multiplied + 10;
    result
}
